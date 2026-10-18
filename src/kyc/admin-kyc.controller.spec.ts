import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request = require('supertest');
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffAuthGuard, StaffRole } from '../common/staff/staff-auth.guard';
import { EventPublisherService } from '../events/event-publisher.service';
import { AdminKycController } from './admin-kyc.controller';
import { KycRecord } from './entities/kyc-record.entity';
import { KycReviewService } from './kyc-review.service';

const SECRET = 'secreto-de-prueba-para-tokens-de-empleado-0123456789';
const ID_USER = '11111111-1111-4111-8111-111111111111';

const record = {
  idUser: ID_USER,
  nombres: 'Ana',
  apellidos: 'Pérez',
  tipoDocumento: 'CC',
  numeroDocumento: '1020304050',
  fechaNacimiento: '1990-05-10',
  fechaExpedicion: '2008-06-01',
  email: 'ana@example.com',
  telefono: '+573001112233',
  status: 'rejected',
  rejectionCode: 'nombre_no_coincide',
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as KycRecord;

describe('Permisos del panel de KYC (403 por rol)', () => {
  let app: INestApplication;
  const jwt = new JwtService({});
  const audit = { record: jest.fn(), list: jest.fn().mockResolvedValue({ items: [] }) };
  const review = { approve: jest.fn().mockResolvedValue({ ...record, status: 'verified' }) };

  const token = (role: StaffRole) =>
    `Bearer ${jwt.sign({ sub: `staff-${role}`, type: 'staff', role, username: role }, { secret: SECRET })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminKycController],
      providers: [
        StaffAuthGuard,
        { provide: JwtService, useValue: jwt },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'STAFF_JWT_SECRET' ? SECRET : undefined) },
        },
        { provide: getRepositoryToken(KycRecord), useValue: { findOne: jest.fn().mockResolvedValue(record) } },
        { provide: EventPublisherService, useValue: { stats: jest.fn().mockResolvedValue({}) } },
        { provide: AdminAuditService, useValue: audit },
        { provide: KycReviewService, useValue: review },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('sin token responde 401', async () => {
    await request(app.getHttpServer()).get(`/kyc/admin/records/${ID_USER}`).expect(401);
  });

  it('Soporte NO puede abrir la ficha completa (403)', async () => {
    await request(app.getHttpServer())
      .get(`/kyc/admin/records/${ID_USER}`)
      .set('Authorization', token('support'))
      .expect(403);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('Soporte NO puede aprobar una verificación (403)', async () => {
    await request(app.getHttpServer())
      .post(`/kyc/admin/records/${ID_USER}/approve`)
      .set('Authorization', token('support'))
      .send({ reason: 'El nombre tenía una tilde de más' })
      .expect(403);
    expect(review.approve).not.toHaveBeenCalled();
  });

  it('Soporte sí ve el resumen, sin datos personales', async () => {
    const res = await request(app.getHttpServer())
      .get(`/kyc/admin/records/${ID_USER}/resumen`)
      .set('Authorization', token('support'))
      .expect(200);
    expect(res.body.nombres).toBe('Ana');
    expect(res.body.numeroDocumento).toBeUndefined();
    expect(res.body.fechaNacimiento).toBeUndefined();
    expect(res.body.telefono).toBeUndefined();
  });

  it.each<StaffRole>(['compliance', 'admin'])('%s abre la ficha completa y queda en la auditoría', async (role) => {
    const res = await request(app.getHttpServer())
      .get(`/kyc/admin/records/${ID_USER}`)
      .set('Authorization', token(role))
      .expect(200);
    expect(res.body.numeroDocumento).toBe('1020304050');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ role }),
      expect.objectContaining({ action: 'kyc.view', targetId: ID_USER }),
    );
  });

  it.each<StaffRole>(['compliance', 'admin'])('%s puede pedir la aprobación manual', async (role) => {
    await request(app.getHttpServer())
      .post(`/kyc/admin/records/${ID_USER}/approve`)
      .set('Authorization', token(role))
      .send({ reason: 'El nombre tenía una tilde de más' })
      .expect(200);
    expect(review.approve).toHaveBeenCalledWith(
      ID_USER,
      'El nombre tenía una tilde de más',
      expect.objectContaining({ role }),
    );
  });

  it('la aprobación exige un motivo', async () => {
    await request(app.getHttpServer())
      .post(`/kyc/admin/records/${ID_USER}/approve`)
      .set('Authorization', token('compliance'))
      .send({ reason: 'corto' })
      .expect(400);
  });
});
