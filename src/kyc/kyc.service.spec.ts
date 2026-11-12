import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { EventPublisherService } from '../events/event-publisher.service';
import { KycService } from './kyc.service';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { VerifikService } from './verifik.service';

process.env.KYC_ENCRYPTION_KEY = 'c'.repeat(64);

/**
 * Verificación de identidad (repositorio, Verifik y eventos simulados). Reglas: menor de edad o
 * fecha de expedición inválida se rechazan antes de guardar; un documento o teléfono verificado
 * pertenece a una sola cuenta; el token de envío protege el registro; y nunca se llama a Verifik real.
 */
const ANA = '11111111-1111-4111-8111-111111111111';
const LUIS = '22222222-2222-4222-8222-222222222222';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

const dto = (over: Partial<SubmitKycDto> = {}): SubmitKycDto => ({
  idUser: ANA,
  nombres: 'Ana María',
  apellidos: 'Pérez',
  tipoDocumento: 'CC',
  numeroDocumento: '1000000001',
  fechaNacimiento: '1990-01-01',
  fechaExpedicion: '2010-01-01',
  email: 'ana@example.com',
  telefono: '3001234567',
  ...over,
});

describe('KycService', () => {
  let saved: any[];
  let previo: any;
  const found: Record<string, any> = {};
  const manager: any = {};
  const records: any = {};
  const events = { publish: jest.fn(), flush: jest.fn() };
  const verifik = { verifyDocument: jest.fn(), verifyAntecedentes: jest.fn() };

  const build = (env: Record<string, string> = {}) =>
    new KycService(
      records,
      events as unknown as EventPublisherService,
      verifik as unknown as VerifikService,
      new ConfigService(env),
    );

  beforeEach(() => {
    jest.clearAllMocks();
    saved = [];
    previo = null;
    for (const key of Object.keys(found)) delete found[key];
    manager.getRepository = () => ({
      save: jest.fn(async (r: any) => {
        saved.push({ ...r });
        return { id: 'r1', ...r };
      }),
    });
    records.manager = { transaction: jest.fn(async (cb: any) => cb(manager)) };
    records.create = jest.fn((r: any) => ({ ...r }));
    records.createQueryBuilder = jest.fn(() => {
      const qb: any = {};
      qb.addSelect = jest.fn(() => qb);
      qb.where = jest.fn(() => qb);
      qb.getOne = jest.fn(async () => previo);
      return qb;
    });
    records.findOne = jest.fn(async ({ where }: any) => {
      if (where.numeroDocumentoHash) return found.documento ?? null;
      if (where.telefonoHash) return found.telefono ?? null;
      return found.porUsuario ?? null;
    });
    verifik.verifyDocument.mockResolvedValue({
      matched: true,
      provider: 'verifik-demo',
      nombreCompleto: 'Ana María Pérez',
    });
    verifik.verifyAntecedentes.mockResolvedValue({
      cleared: true,
      provider: 'verifik-antecedentes-demo',
      nivelRiesgo: 'bajo',
      alertas: [],
    });
  });

  describe('submit', () => {
    it('aprobada: guarda el registro verificado, entrega un token de envío y publica solo el idUser', async () => {
      const result = await build().submit(dto());

      expect(result.status).toBe('verified');
      expect(result.submissionToken).toMatch(/^[0-9a-f]{64}$/);
      expect(result.provider).toMatchObject({ verified: true, rejectionCode: null });
      expect(saved[0].submissionTokenHash).toBe(hash(result.submissionToken!));
      expect(saved[0].numeroDocumentoHash).toMatch(/^[0-9a-f]{64}$/);
      expect(events.publish).toHaveBeenCalledWith('identity.verified', { idUser: ANA }, manager);
      expect(events.flush).toHaveBeenCalled();
      // El hash del token, del documento y del teléfono no se devuelven
      expect(result).not.toHaveProperty('submissionTokenHash');
      expect(result).not.toHaveProperty('numeroDocumentoHash');
      expect(result).not.toHaveProperty('telefonoHash');
    });

    it('modo demo por defecto: pasa por Verifik con el nombre completo', async () => {
      await build().submit(dto());
      expect(verifik.verifyDocument).toHaveBeenCalledWith('1000000001', 'CC', 'Ana María Pérez');
      expect(verifik.verifyAntecedentes).toHaveBeenCalledWith('1000000001', 'CC');
    });

    it('REGLA DURA: un menor de edad se rechaza sin guardar ni consultar a nadie', async () => {
      const menor = new Date();
      menor.setUTCFullYear(menor.getUTCFullYear() - 17);
      const nacimiento = menor.toISOString().slice(0, 10);

      await expect(build().submit(dto({ fechaNacimiento: nacimiento }))).rejects.toThrow(BadRequestException);

      expect(verifik.verifyDocument).not.toHaveBeenCalled();
      expect(saved).toEqual([]);
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('REGLA DURA: una cédula expedida antes de cumplir 18 años se rechaza sin guardar', async () => {
      await expect(build().submit(dto({ fechaExpedicion: '2000-01-01' }))).rejects.toThrow(
        'posterior a cuando el usuario cumplió 18 años',
      );
      expect(saved).toEqual([]);
    });

    it('en modo live solo se verifica CC: los demás tipos se rechazan antes de consultar a Verifik', async () => {
      await expect(build({ VERIFIK_MODE: 'live' }).submit(dto({ tipoDocumento: 'CE' }))).rejects.toThrow(
        'solo podemos verificar en línea estos documentos: CC',
      );
      expect(verifik.verifyDocument).not.toHaveBeenCalled();

      await build({ VERIFIK_MODE: 'LIVE' }).submit(dto());
      expect(verifik.verifyDocument).toHaveBeenCalled();
    });

    it('un documento no encontrado se guarda como rechazado con su motivo y no consulta antecedentes', async () => {
      verifik.verifyDocument.mockResolvedValue({
        matched: false,
        code: 'documento_no_encontrado',
        provider: 'verifik',
        nombreCompleto: null,
        message: 'El documento no fue encontrado en la fuente oficial.',
      });

      const result = await build().submit(dto());

      expect(result.status).toBe('rejected');
      expect(verifik.verifyAntecedentes).not.toHaveBeenCalled();
      expect(saved[0]).toMatchObject({ status: 'rejected', rejectionCode: 'documento_no_encontrado' });
      expect(events.publish).toHaveBeenCalledWith(
        'identity.rejected',
        { idUser: ANA, email: 'ana@example.com', nombreCompleto: 'Ana María Pérez' },
        manager,
      );
      expect(events.publish).not.toHaveBeenCalledWith('identity.verified', expect.anything(), expect.anything());
    });

    it('un documento rechazado sin motivo cae en "documento_no_encontrado"', async () => {
      verifik.verifyDocument.mockResolvedValue({ matched: false, provider: 'verifik', nombreCompleto: null });
      expect((await build().submit(dto())).provider?.rejectionCode).toBe('documento_no_encontrado');
    });

    it('REGLA DURA: con antecedentes pendientes la identidad queda rechazada y no se publica identity.verified', async () => {
      verifik.verifyAntecedentes.mockResolvedValue({
        cleared: false,
        code: 'antecedentes_pendientes',
        provider: 'verifik-antecedentes',
        nivelRiesgo: 'alto',
        alertas: ['Registra asuntos pendientes con las autoridades judiciales'],
      });

      const result = await build().submit(dto());

      expect(result.status).toBe('rejected');
      expect(result.provider).toMatchObject({
        verified: false,
        rejectionCode: 'antecedentes_pendientes',
        rejectionMessage: 'Registra asuntos pendientes con las autoridades judiciales',
      });
      expect(events.publish).toHaveBeenCalledWith('identity.rejected', expect.anything(), manager);
      expect(events.publish).not.toHaveBeenCalledWith('identity.verified', expect.anything(), expect.anything());
    });

    it('antecedentes no aprobados sin motivo ni mensaje caen en "antecedentes_no_confirmados"', async () => {
      verifik.verifyAntecedentes.mockResolvedValue({
        cleared: false,
        provider: 'verifik-antecedentes',
        nivelRiesgo: 'desconocido',
        alertas: [],
      });
      const result = await build().submit(dto());
      expect(result.provider).toMatchObject({ rejectionCode: 'antecedentes_no_confirmados', rejectionMessage: null });
    });

    it('el mensaje del rechazo se recorta a 300 caracteres', async () => {
      verifik.verifyDocument.mockResolvedValue({
        matched: false,
        code: 'nombre_no_coincide',
        provider: 'verifik',
        nombreCompleto: 'X',
        message: 'm'.repeat(500),
      });
      await build().submit(dto());
      expect(saved[0].rejectionMessage).toHaveLength(300);
    });

    it('si Verifik no está disponible el error sube y no se guarda nada', async () => {
      verifik.verifyDocument.mockRejectedValue(new Error('503'));
      await expect(build().submit(dto())).rejects.toThrow('503');
      expect(saved).toEqual([]);
    });

    describe('unicidad', () => {
      it('un documento que ya es de otra cuenta da 409', async () => {
        found.documento = { idUser: LUIS };
        await expect(build().submit(dto())).rejects.toThrow('El número de documento ya está registrado');
        expect(verifik.verifyDocument).not.toHaveBeenCalled();
      });

      it('el mismo usuario puede reenviar su documento', async () => {
        found.documento = { idUser: ANA };
        await expect(build().submit(dto())).resolves.toMatchObject({ status: 'verified' });
      });

      it('un teléfono VERIFICADO de otra cuenta da 409; si esa otra cuenta no está verificada, no estorba', async () => {
        found.telefono = { idUser: LUIS, status: 'verified' };
        await expect(build().submit(dto())).rejects.toThrow('Numero de telefono registrado en otra cuenta');

        found.telefono = { idUser: LUIS, status: 'rejected' };
        await expect(build().submit(dto())).resolves.toMatchObject({ status: 'verified' });
      });

      it('sin teléfono no se busca por teléfono', async () => {
        await build().submit(dto({ telefono: '  ' }));
        expect(records.findOne).toHaveBeenCalledTimes(1);
      });

      it('una violación de unicidad de la base (registros simultáneos) también da 409, según el campo', async () => {
        manager.getRepository = () => ({
          save: jest.fn().mockRejectedValueOnce({ code: '23505', detail: 'Key (telefono_hash)=(x) already exists.' }),
        });
        await expect(build().submit(dto())).rejects.toThrow('Numero de telefono registrado');

        manager.getRepository = () => ({
          save: jest.fn().mockRejectedValueOnce({ code: '23505', detail: 'Key (numero_documento_hash)' }),
        });
        await expect(build().submit(dto())).rejects.toThrow(ConflictException);

        manager.getRepository = () => ({ save: jest.fn().mockRejectedValueOnce(new Error('caída')) });
        await expect(build().submit(dto())).rejects.toThrow('caída');
      });
    });

    describe('reenvío del mismo usuario (token de envío)', () => {
      const token = 'token-original';
      const existente = (over: Record<string, unknown> = {}) => ({
        idUser: ANA,
        status: 'rejected',
        submissionTokenHash: hash(token),
        ...over,
      });

      it('con el token correcto actualiza el mismo registro, conserva el token y no entrega otro', async () => {
        previo = existente();

        const result = await build().submit(dto({ submissionToken: token }));

        expect(result.submissionToken).toBeUndefined();
        expect(result.status).toBe('verified');
        expect(saved[0].submissionTokenHash).toBe(hash(token));
        expect(records.create).not.toHaveBeenCalled();
      });

      it('sin token o con uno ajeno da 403 y no se toca el registro', async () => {
        previo = existente();
        await expect(build().submit(dto())).rejects.toThrow(ForbiddenException);
        await expect(build().submit(dto({ submissionToken: 'otro' }))).rejects.toThrow(
          'No puedes modificar la verificación de identidad',
        );
        expect(saved).toEqual([]);
      });

      it('un registro antiguo (sin token) ya verificado no se puede reescribir', async () => {
        previo = existente({ submissionTokenHash: null, status: 'verified' });
        await expect(build().submit(dto())).rejects.toThrow('ya fue verificada');
      });

      it('un registro antiguo (sin token) no verificado se reenvía y recibe su token por primera vez', async () => {
        previo = existente({ submissionTokenHash: null, status: 'rejected' });
        const result = await build().submit(dto());
        expect(result.submissionToken).toMatch(/^[0-9a-f]{64}$/);
      });
    });
  });

  describe('consultas', () => {
    it('isVerified: solo true con un registro verificado', async () => {
      found.porUsuario = { status: 'verified' };
      expect(await build().isVerified(ANA)).toBe(true);
      found.porUsuario = { status: 'rejected' };
      expect(await build().isVerified(ANA)).toBe(false);
      delete found.porUsuario;
      expect(await build().isVerified(ANA)).toBe(false);
    });

    it('getIdentityStatus devuelve si está verificada y el nombre, o nada si no hay registro', async () => {
      found.porUsuario = { status: 'verified', nombres: 'Ana', apellidos: 'Pérez' };
      expect(await build().getIdentityStatus(ANA)).toEqual({ verified: true, nombreCompleto: 'Ana Pérez' });
      delete found.porUsuario;
      expect(await build().getIdentityStatus(ANA)).toEqual({ verified: false, nombreCompleto: null });
    });

    it('findByUser: el registro, o 404', async () => {
      found.porUsuario = { idUser: ANA };
      expect(await build().findByUser(ANA)).toEqual({ idUser: ANA });
      delete found.porUsuario;
      await expect(build().findByUser(ANA)).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateContact', () => {
    const verificado = (over: Record<string, unknown> = {}) => ({
      idUser: ANA,
      status: 'verified',
      nombres: 'Ana',
      apellidos: 'Pérez',
      email: 'viejo@example.com',
      telefono: '3000000000',
      ...over,
    });

    it('sin registro da 404', async () => {
      await expect(build().updateContact({ idUser: ANA, email: 'a@b.co' })).rejects.toThrow(NotFoundException);
    });

    it('guarda el correo en minúsculas y el teléfono recortado, con sus índices ciegos', async () => {
      found.porUsuario = verificado();

      const result = await build().updateContact({
        idUser: ANA,
        email: ' Nuevo@Example.COM ',
        telefono: ' 3111111111 ',
      });

      expect(result).toEqual({ idUser: ANA, email: 'nuevo@example.com', telefono: '3111111111' });
      expect(saved[0].telefonoHash).toMatch(/^[0-9a-f]{64}$/);
      expect(events.flush).toHaveBeenCalled();
    });

    it('si el correo verificado cambió, publica la confirmación por correo', async () => {
      found.porUsuario = verificado();
      await build().updateContact({ idUser: ANA, email: 'nuevo@example.com' });
      expect(events.publish).toHaveBeenCalledWith(
        'identity.email_confirmed',
        { idUser: ANA, email: 'nuevo@example.com', nombreCompleto: 'Ana Pérez' },
        manager,
      );
    });

    it('no publica nada si el correo no cambió, si solo cambia el teléfono o si la identidad no está verificada', async () => {
      found.porUsuario = verificado();
      await build().updateContact({ idUser: ANA, email: 'VIEJO@example.com' });
      found.porUsuario = verificado();
      await build().updateContact({ idUser: ANA, telefono: '3222222222' });
      found.porUsuario = verificado({ status: 'rejected' });
      await build().updateContact({ idUser: ANA, email: 'otro@example.com' });

      expect(events.publish).not.toHaveBeenCalled();
    });
  });
});
