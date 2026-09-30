import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventPublisherService } from '../events/event-publisher.service';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { KycRecord } from './entities/kyc-record.entity';
import { VerifikService } from './verifik.service';

const EDAD_MINIMA = 18;

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
  ) {}

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
  async submit(
    dto: SubmitKycDto,
  ): Promise<KycRecord & { provider?: IdentityProviderResult }> {
    this.validarMayoriaDeEdad(dto.fechaNacimiento);
    this.validarFechaExpedicion(dto.fechaNacimiento, dto.fechaExpedicion);

    // Un documento solo puede estar asociado a una cuenta. La restricción
    // UNIQUE en la BD refuerza esta validación ante registros simultáneos.
    const documentoExistente = await this.records.findOne({
      where: { numeroDocumento: dto.numeroDocumento },
    });
    if (documentoExistente && documentoExistente.idUser !== dto.idUser) {
      throw new ConflictException('El número de documento ya está registrado en otra cuenta.');
    }

    if (dto.telefono?.trim()) {
      const telefonoExistente = await this.records.findOne({ where: { telefono: dto.telefono.trim() } });
      if (telefonoExistente && telefonoExistente.idUser !== dto.idUser && telefonoExistente.status === 'verified') {
        throw new ConflictException('Numero de telefono registrado en otra cuenta ');
      }
    }

    const provider = await this.verificarIdentidad(dto);

    if (!provider.verified) {
      let rejected = await this.records.findOne({ where: { idUser: dto.idUser } });
      if (!rejected) rejected = this.records.create({ ...dto, status: 'rejected' });
      else Object.assign(rejected, dto, { status: 'rejected' as const });
      const saved = await this.records.save(rejected);
      return { ...saved, provider };
    }

    let record = await this.records.findOne({ where: { idUser: dto.idUser } });
    if (record) {
      Object.assign(record, dto, { status: 'verified' as const });
    } else {
      record = this.records.create({ ...dto, status: 'verified' });
    }
    try {
      record = await this.records.save(record);
    } catch (error) {
      // PostgreSQL unique violation (23505) for documento duplicado.
      if ((error as any)?.code === '23505') {
        const detail = String((error as any)?.detail || '');
        if (detail.includes('telefono')) {
          throw new ConflictException('Numero de telefono registrado en otra cuenta ');
        }
        throw new ConflictException('El número de documento ya está registrado en otra cuenta.');
      }
      throw error;
    }

    await this.events.publish('identity.verified', {
      idUser: record.idUser,
      numeroDocumento: record.numeroDocumento,
      documentProvider: provider.document.provider,
      backgroundProvider: provider.background.provider,
      nombreCompleto: provider.document.nombreCompleto,
      nivelRiesgo: provider.background.nivelRiesgo,
      alertas: provider.background.alertas,
    });

    return { ...record, provider };
  }

  /**
   * Orquesta las dos consultas de Verifik: documento (Registraduría) y
   * antecedentes (Policía). La de documento corre primero: si no es válido
   * no tiene sentido gastar la segunda consulta. La identidad solo queda
   * "verified" si ambas se aprueban.
   */
  private async verificarIdentidad(dto: SubmitKycDto): Promise<IdentityProviderResult> {
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

    if (dto.email !== undefined) record.email = dto.email.trim().toLowerCase();
    if (dto.telefono !== undefined) record.telefono = dto.telefono.trim();
    await this.records.save(record);
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