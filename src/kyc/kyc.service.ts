import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { Repository, EntityManager } from 'typeorm';
import { EventPublisherService } from '../events/event-publisher.service';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { blindIndex } from '../common/crypto/field-crypto';
import { KycRecord } from './entities/kyc-record.entity';
import { VerifikService } from './verifik.service';

const EDAD_MINIMA = 18;

// En modo live solo se aprueba si el documento pasa las DOS consultas de Verifik:
// cédula (CC, PPT) y antecedentes (CC, CE). Hoy la única intersección es CC.
const TIPOS_VERIFICABLES_LIVE = ['CC'];

type PublicKycRecord = Omit<KycRecord, 'submissionTokenHash' | 'numeroDocumentoHash' | 'telefonoHash'>;
type SubmitResult = PublicKycRecord & {
  provider?: IdentityProviderResult;
  submissionToken?: string;
};

interface IdentityProviderResult {
  verified: boolean;
  document: { provider: string; nombreCompleto: string | null; message?: string };
  background: { provider: string; nivelRiesgo: string; alertas: string[]; message?: string };
}

@Injectable()
export class KycService {
  constructor(
    @InjectRepository(KycRecord) private readonly records: Repository<KycRecord>,
    private readonly events: EventPublisherService,
    private readonly verifik: VerifikService,
    private readonly config: ConfigService,
  ) {}

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private tokenMatches(token: string | undefined, hash: string | null): boolean {
    if (!token || !hash) return false;
    const a = Buffer.from(this.hashToken(token));
    const b = Buffer.from(hash);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Quita el hash del token antes de devolver el registro. */
  private publicRecord(record: KycRecord): PublicKycRecord {
    const { submissionTokenHash: _omit, numeroDocumentoHash: _doc, telefonoHash: _tel, ...rest } = record;
    return rest;
  }

  private isLiveMode(): boolean {
    return (this.config.get<string>('VERIFIK_MODE') || 'demo').toLowerCase() === 'live';
  }

  /**
   * POST /kyc/submit
   * Endpoint público (igual que /auth/register): se llama justo después de
   * crear las credenciales en Auth Service, en cuanto el usuario completa
   * el paso "Cuéntanos quién eres" del registro. En este punto todavía no
   * se han verificado correo ni teléfono (eso ocurre en pasos posteriores).
   *
   * Valida mayoría de edad (defensa en profundidad: el frontend ya lo valida,
   * pero el backend nunca debe confiar únicamente en la validación del
   * cliente) y hace dos consultas en cadena, ambas con Verifik:
   *   1. Cédula (Registraduría): confirma que el documento existe y que el
   *      nombre coincide.
   *   2. Antecedentes judiciales (Policía Nacional) sobre la persona ya
   *      validada en el paso anterior.
   * Si ambas pasan, marca la verificación como aprobada y publica
   * identity.verified para que Account Service active la cuenta.
   */
  async submit(dto: SubmitKycDto): Promise<SubmitResult> {
    const { submissionToken, ...datos } = dto;
    this.validarMayoriaDeEdad(datos.fechaNacimiento);
    this.validarFechaExpedicion(datos.fechaNacimiento, datos.fechaExpedicion);

    if (this.isLiveMode() && !TIPOS_VERIFICABLES_LIVE.includes(datos.tipoDocumento)) {
      throw new BadRequestException(
        `Por ahora solo podemos verificar en línea estos documentos: ${TIPOS_VERIFICABLES_LIVE.join(', ')}.`,
      );
    }

    // Registro previo de este idUser (con el hash del token, que no se carga por defecto).
    const previo = await this.records
      .createQueryBuilder('r')
      .addSelect('r.submissionTokenHash')
      .where('r.idUser = :idUser', { idUser: datos.idUser })
      .getOne();
    if (previo) {
      if (!previo.submissionTokenHash) {
        // Registro anterior a los tokens: si ya está verificado no se puede reescribir.
        if (previo.status === 'verified') {
          throw new ConflictException('La identidad de este usuario ya fue verificada.');
        }
      } else if (!this.tokenMatches(submissionToken, previo.submissionTokenHash)) {
        throw new ForbiddenException('No puedes modificar la verificación de identidad de este usuario.');
      }
    }
    // Token nuevo solo si el registro aún no tiene uno; en reenvíos se conserva.
    const nuevoToken = previo?.submissionTokenHash ? undefined : randomBytes(32).toString('hex');
    const tokenHash = nuevoToken ? this.hashToken(nuevoToken) : previo?.submissionTokenHash ?? null;

    // Un documento solo puede estar asociado a una cuenta. La restricción
    // UNIQUE en la BD refuerza esta validación ante registros simultáneos.
    const documentoExistente = await this.records.findOne({
      where: { numeroDocumentoHash: blindIndex(datos.numeroDocumento) as string },
    });
    if (documentoExistente && documentoExistente.idUser !== datos.idUser) {
      throw new ConflictException('El número de documento ya está registrado en otra cuenta.');
    }

    if (datos.telefono?.trim()) {
      const telefonoExistente = await this.records.findOne({ where: { telefonoHash: blindIndex(datos.telefono) as string } });
      if (telefonoExistente && telefonoExistente.idUser !== datos.idUser && telefonoExistente.status === 'verified') {
        throw new ConflictException('Numero de telefono registrado en otra cuenta ');
      }
    }

    const provider = await this.verificarIdentidad(datos);
    const status = provider.verified ? ('verified' as const) : ('rejected' as const);

    let record: KycRecord = previo ?? this.records.create({ ...datos, status });
    Object.assign(record, datos, { status, submissionTokenHash: tokenHash });
    // Registro y evento en la misma transacción (outbox transaccional).
    record = await this.records.manager.transaction(async (manager) => {
      const saved = await this.saveRecord(record, manager);
      if (!provider.verified) {
        await this.events.publish('identity.rejected', {
          idUser: saved.idUser,
          email: saved.email,
          nombreCompleto: `${saved.nombres} ${saved.apellidos}`.trim(),
        }, manager);
      } else {
        // Solo el idUser: el documento, el nombre, el nivel de riesgo y las
        // alertas viven cifrados en kyc_db y no deben viajar en claro por el
        // bus ni copiarse a otras bases. Account Service solo necesita el idUser.
        await this.events.publish('identity.verified', { idUser: saved.idUser }, manager);
      }
      return saved;
    });
    void this.events.flush();

    return { ...this.publicRecord(record), provider, submissionToken: nuevoToken };
  }

  /** Guarda traduciendo las violaciones de unicidad (documento / teléfono) a 409. */
  private async saveRecord(record: KycRecord, manager?: EntityManager): Promise<KycRecord> {
    // Índices ciegos de los campos cifrados (unicidad y búsqueda exacta).
    record.numeroDocumentoHash = blindIndex(record.numeroDocumento);
    record.telefonoHash = blindIndex(record.telefono);
    try {
      return await (manager ? manager.getRepository(KycRecord) : this.records).save(record);
    } catch (error) {
      if ((error as any)?.code === '23505') {
        const detail = String((error as any)?.detail || '');
        if (detail.includes('telefono')) {
          throw new ConflictException('Numero de telefono registrado en otra cuenta ');
        }
        throw new ConflictException('El número de documento ya está registrado en otra cuenta.');
      }
      throw error;
    }
  }

  /**
   * Orquesta las dos consultas de Verifik: documento (Registraduría) y
   * antecedentes (Policía). La de documento corre primero: si no es válido
   * no tiene sentido gastar la segunda consulta. La identidad solo queda
   * "verified" si ambas se aprueban.
   */
  private async verificarIdentidad(dto: Omit<SubmitKycDto, 'submissionToken'>): Promise<IdentityProviderResult> {
    const nombreCompleto = `${dto.nombres} ${dto.apellidos}`.trim();

    const verifikResult = await this.verifik.verifyDocument(
      dto.numeroDocumento,
      dto.tipoDocumento,
      nombreCompleto,
    );

    if (!verifikResult.matched) {
      return {
        verified: false,
        document: {
          provider: verifikResult.provider,
          nombreCompleto: verifikResult.nombreCompleto,
          message: verifikResult.message,
        },
        background: { provider: 'verifik-antecedentes', nivelRiesgo: 'no-evaluado', alertas: [] },
      };
    }

    const antecedentes = await this.verifik.verifyAntecedentes(dto.numeroDocumento, dto.tipoDocumento);

    return {
      verified: verifikResult.matched && antecedentes.cleared,
      document: {
        provider: verifikResult.provider,
        nombreCompleto: verifikResult.nombreCompleto,
        message: verifikResult.message,
      },
      background: {
        provider: antecedentes.provider,
        nivelRiesgo: antecedentes.nivelRiesgo,
        alertas: antecedentes.alertas,
        message: antecedentes.message,
      },
    };
  }

  /** GET /kyc/status/:idUser (interno) — ¿la identidad de este usuario está verificada? */
  async isVerified(idUser: string): Promise<boolean> {
    const record = await this.records.findOne({ where: { idUser } });
    return !!record && record.status === 'verified';
  }

  async getIdentityStatus(idUser: string) {
    const record = await this.records.findOne({ where: { idUser } });
    return {
      verified: !!record && record.status === 'verified',
      nombreCompleto: record ? `${record.nombres} ${record.apellidos}`.trim() : null,
    };
  }

  /** GET /kyc/:idUser */
  async findByUser(idUser: string): Promise<KycRecord> {
    const record = await this.records.findOne({ where: { idUser } });
    if (!record) {
      throw new NotFoundException('No se encontró verificación de identidad para este usuario');
    }
    return record;
  }

  async updateContact(dto: UpdateContactDto): Promise<Pick<KycRecord, 'idUser' | 'email' | 'telefono'>> {
    const record = await this.records.findOne({ where: { idUser: dto.idUser } });
    if (!record) {
      throw new NotFoundException('No se encontro verificacion de identidad para este usuario');
    }

    const emailAnterior = record.email;
    if (dto.email !== undefined) record.email = dto.email.trim().toLowerCase();
    if (dto.telefono !== undefined) record.telefono = dto.telefono.trim();
    await this.records.manager.transaction(async (manager) => {
      await this.saveRecord(record, manager);
      // La identidad se verifica antes de conocer el correo, así que la confirmación
      // por email se envía cuando llega el correo verificado (solo si cambió).
      if (record.status === 'verified' && record.email && record.email !== emailAnterior) {
        await this.events.publish('identity.email_confirmed', {
          idUser: record.idUser,
          email: record.email,
          nombreCompleto: `${record.nombres} ${record.apellidos}`.trim(),
        }, manager);
      }
    });
    void this.events.flush();
    return { idUser: record.idUser, email: record.email, telefono: record.telefono };
  }

  private validarMayoriaDeEdad(fechaNacimientoStr: string) {
    const nacimiento = new Date(fechaNacimientoStr + 'T00:00:00Z');
    const hoy = new Date();
    let edad = hoy.getUTCFullYear() - nacimiento.getUTCFullYear();
    const difMes = hoy.getUTCMonth() - nacimiento.getUTCMonth();
    if (difMes < 0 || (difMes === 0 && hoy.getUTCDate() < nacimiento.getUTCDate())) edad--;
    if (edad < EDAD_MINIMA) {
      throw new BadRequestException('El usuario debe ser mayor de 18 años para abrir una cuenta');
    }
  }

  private validarFechaExpedicion(fechaNacimientoStr: string, fechaExpedicionStr: string) {
    const nacimiento = new Date(fechaNacimientoStr + 'T00:00:00Z');
    const expedicion = new Date(fechaExpedicionStr + 'T00:00:00Z');
    const fecha18 = new Date(nacimiento);
    fecha18.setUTCFullYear(fecha18.getUTCFullYear() + 18);
    if (expedicion < fecha18) {
      throw new BadRequestException(
        'La fecha de expedición del documento debe ser posterior a cuando el usuario cumplió 18 años',
      );
    }
  }
}