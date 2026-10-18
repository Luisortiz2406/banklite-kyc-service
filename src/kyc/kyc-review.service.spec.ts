import { ConflictException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffPrincipal } from '../common/staff/staff-auth.guard';
import { staffDocHash } from '../common/staff/staff-doc-hash';
import { EventPublisherService } from '../events/event-publisher.service';
import { KycRecord } from './entities/kyc-record.entity';
import { KycReviewService } from './kyc-review.service';
import { RejectionCode } from './rejection-rules';

const SECRET = 'secreto-de-prueba-para-tokens-de-empleado-0123456789';
const ID_USER = '11111111-1111-4111-8111-111111111111';
const REASON = 'Revisé el documento con el cliente: el nombre tenía una tilde de más';

function buildRecord(overrides: Partial<KycRecord> = {}): KycRecord {
  return {
    idUser: ID_USER,
    nombres: 'Ana',
    apellidos: 'Pérez',
    tipoDocumento: 'CC',
    numeroDocumento: '1020304050',
    fechaNacimiento: '1990-05-10',
    fechaExpedicion: '2008-06-01',
    status: 'rejected',
    rejectionCode: 'nombre_no_coincide',
    ...overrides,
  } as KycRecord;
}

function setup(record: KycRecord | null) {
  const saved: KycRecord[] = [];
  const manager = { save: jest.fn(async (r: KycRecord) => (saved.push({ ...r }), r)) };
  const repo = {
    findOne: jest.fn().mockResolvedValue(record),
    manager: { transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn(manager)) },
  };
  const audit = { record: jest.fn() };
  const events = { publish: jest.fn(), flush: jest.fn().mockResolvedValue(undefined) };
  const config = { get: (key: string) => (key === 'STAFF_JWT_SECRET' ? SECRET : undefined) };
  const service = new KycReviewService(
    repo as never,
    audit as unknown as AdminAuditService,
    events as unknown as EventPublisherService,
    config as unknown as ConfigService,
  );
  return { service, saved, audit, events };
}

const compliance: StaffPrincipal = {
  id: 'staff-1',
  username: 'cumplimiento1',
  role: 'compliance',
  docHash: staffDocHash(SECRET, '99887766'),
};

describe('Aprobación manual de verificaciones de identidad', () => {
  it('aprueba un rechazo por datos que no coincidieron, lo audita y publica identity.verified', async () => {
    const { service, saved, audit, events } = setup(buildRecord());
    const result = await service.approve(ID_USER, REASON, compliance);

    expect(result.status).toBe('verified');
    expect(saved[0]).toMatchObject({ status: 'verified', reviewedBy: 'cumplimiento1', reviewedByRole: 'compliance' });
    expect(audit.record).toHaveBeenCalledWith(
      compliance,
      expect.objectContaining({ action: 'kyc.manual_approve', targetId: ID_USER, reason: REASON }),
      expect.anything(),
    );
    expect(events.publish).toHaveBeenCalledWith('identity.verified', { idUser: ID_USER }, expect.anything());
  });

  it.each<RejectionCode>([
    'documento_tipo_no_soportado',
    'documento_no_encontrado',
    'documento_sin_nombre',
    'antecedentes_tipo_no_soportado',
    'antecedentes_no_confirmados',
  ])('también aprueba validaciones fallidas: %s', async (rejectionCode) => {
    const { service } = setup(buildRecord({ rejectionCode }));
    await expect(service.approve(ID_USER, REASON, compliance)).resolves.toMatchObject({ status: 'verified' });
  });

  describe('reglas duras: nunca se aprueban a mano', () => {
    it.each<RejectionCode>([
      'documento_no_vigente',
      'antecedentes_pendientes',
      'menor_de_edad',
      'fecha_expedicion_invalida',
    ])('rechazo por %s', async (rejectionCode) => {
      const { service, saved, events } = setup(buildRecord({ rejectionCode }));
      await expect(service.approve(ID_USER, REASON, compliance)).rejects.toThrow(UnprocessableEntityException);
      expect(saved).toHaveLength(0);
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('menor de edad según los datos guardados, aunque el motivo sea aprobable', async () => {
      const hace16 = `${new Date().getUTCFullYear() - 16}-01-01`;
      const { service } = setup(buildRecord({ fechaNacimiento: hace16, fechaExpedicion: '2024-01-01' }));
      await expect(service.approve(ID_USER, REASON, compliance)).rejects.toThrow(/Menor de edad/);
    });

    it('fecha de expedición anterior a los 18 años, aunque el motivo sea aprobable', async () => {
      const { service } = setup(buildRecord({ fechaNacimiento: '1990-05-10', fechaExpedicion: '2005-01-01' }));
      await expect(service.approve(ID_USER, REASON, compliance)).rejects.toThrow(/Fecha de expedición/);
    });

    it('rechazo sin motivo registrado (anterior a este cambio)', async () => {
      const { service } = setup(buildRecord({ rejectionCode: null }));
      await expect(service.approve(ID_USER, REASON, compliance)).rejects.toThrow(UnprocessableEntityException);
    });
  });

  it('un empleado no puede aprobar su propia verificación', async () => {
    const mismo: StaffPrincipal = { ...compliance, docHash: staffDocHash(SECRET, '1.020.304.050') };
    const { service, saved } = setup(buildRecord());
    await expect(service.approve(ID_USER, REASON, mismo)).rejects.toThrow(ForbiddenException);
    expect(saved).toHaveLength(0);
  });

  it('un empleado sin documento registrado no puede aprobar', async () => {
    const { service } = setup(buildRecord());
    await expect(service.approve(ID_USER, REASON, { ...compliance, docHash: null })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('solo se aprueban verificaciones rechazadas', async () => {
    const { service } = setup(buildRecord({ status: 'verified', rejectionCode: null }));
    await expect(service.approve(ID_USER, REASON, compliance)).rejects.toThrow(ConflictException);
  });
});
