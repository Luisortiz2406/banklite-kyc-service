import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request = require('supertest');
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { EventPublisherService } from '../events/event-publisher.service';
import { KycRecord } from './entities/kyc-record.entity';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';
import { VerifikService } from './verifik.service';

process.env.KYC_ENCRYPTION_KEY = 'c'.repeat(64);

/**
 * Integración del registro de identidad: la petición HTTP real pasa por el controlador, los guards,
 * KycService (reglas de negocio), VerifikService (el proveedor externo, con `fetch` simulado: nunca se
 * llama a Verifik de verdad), el repositorio (en memoria, con las mismas búsquedas por índice ciego que
 * usa el servicio) y el publicador de eventos. Solo se simulan los bordes: base de datos, red y bus.
 */
const ANA = '11111111-1111-4111-8111-111111111111';
const LUIS = '22222222-2222-4222-8222-222222222222';
const CLAVE_AUTH = 'clave-interna-de-prueba-de-auth-0123456789';

const reply = (status: number, body: unknown = {}) =>
  Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  }) as unknown as Promise<Response>;

const solicitud = (over: Record<string, unknown> = {}) => ({
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

describe('Registro de identidad de punta a punta (HTTP, reglas, Verifik simulado y eventos)', () => {
  const realFetch = global.fetch;
  let app: INestApplication;
  let fetchMock: jest.Mock;
  let tabla: Map<string, Record<string, any>>;
  const eventos = { publish: jest.fn(), flush: jest.fn() };

  // Repositorio en memoria: guarda por idUser y responde las mismas consultas que hace KycService.
  const repositorio: any = {
    create: (datos: Record<string, any>) => ({ ...datos }),
    findOne: async ({ where }: { where: Record<string, unknown> }) => {
      const [campo, valor] = Object.entries(where)[0];
      const registro = [...tabla.values()].find((r) => r[campo] === valor);
      return registro ? { ...registro } : null;
    },
    createQueryBuilder: () => {
      let idUser = '';
      const consulta: any = {
        addSelect: () => consulta,
        where: (_sql: string, params: { idUser: string }) => {
          idUser = params.idUser;
          return consulta;
        },
        getOne: async () => (tabla.has(idUser) ? { ...tabla.get(idUser) } : null),
      };
      return consulta;
    },
    manager: {
      transaction: async (trabajo: (manager: unknown) => Promise<unknown>) =>
        trabajo({
          getRepository: () => ({
            save: async (registro: Record<string, any>) => {
              const guardado: Record<string, any> = { id: `registro-${registro.idUser}`, ...registro };
              tabla.set(guardado.idUser, guardado);
              return guardado;
            },
          }),
        }),
    },
  };

  const configuracion = (env: Record<string, string>) => ({
    provide: ConfigService,
    useValue: new ConfigService({
      VERIFIK_MODE: 'live',
      VERIFIK_API_KEY: 'token-de-prueba',
      VERIFIK_API_URL: 'http://verifik.falso/cedula',
      VERIFIK_ANTECEDENTES_URL: 'http://verifik.falso/policia',
      INTERNAL_TRUSTED_KEYS: `auth:${CLAVE_AUTH}`,
      ...env,
    }),
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [KycController],
      providers: [
        KycService,
        VerifikService,
        InternalKeyGuard,
        JwtAuthGuard,
        { provide: JwtService, useValue: new JwtService({}) },
        configuracion({}),
        { provide: getRepositoryToken(KycRecord), useValue: repositorio },
        { provide: EventPublisherService, useValue: eventos },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    global.fetch = realFetch;
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    tabla = new Map();
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });

  const cedulaOk = () => reply(200, { data: { fullName: 'ANA MARÍA PÉREZ GÓMEZ', isAlive: true } });
  const antecedentesLimpios = () => reply(200, { details: 'NO TIENE ASUNTOS PENDIENTES, de acuerdo con la ley' });

  it('una persona mayor de edad con documento y antecedentes limpios queda verificada y account se entera solo por el idUser', async () => {
    fetchMock.mockReturnValueOnce(cedulaOk()).mockReturnValueOnce(antecedentesLimpios());

    const respuesta = await request(app.getHttpServer()).post('/kyc/submit').send(solicitud()).expect(201);

    expect(respuesta.body).toMatchObject({
      idUser: ANA,
      status: 'verified',
      provider: { verified: true, document: { provider: 'verifik' }, background: { nivelRiesgo: 'bajo' } },
    });
    expect(respuesta.body.submissionToken).toMatch(/^[0-9a-f]{64}$/);
    // La respuesta nunca trae los hashes internos
    expect(respuesta.body).not.toHaveProperty('submissionTokenHash');
    expect(respuesta.body).not.toHaveProperty('numeroDocumentoHash');

    // Habló con Verifik dos veces (cédula y luego policía), con el token y el documento
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [primera, segunda] = fetchMock.mock.calls;
    expect(String(primera[0])).toContain('verifik.falso/cedula');
    expect(String(primera[0])).toContain('documentNumber=1000000001');
    expect(primera[1].headers.Authorization).toBe('jwt token-de-prueba');
    expect(String(segunda[0])).toContain('verifik.falso/policia');

    // Quedó guardado verificado y se publicó solo el idUser (nada del documento ni del nombre)
    expect(tabla.get(ANA)).toMatchObject({ status: 'verified', rejectionCode: null });
    expect(eventos.publish).toHaveBeenCalledTimes(1);
    expect(eventos.publish).toHaveBeenCalledWith('identity.verified', { idUser: ANA }, expect.anything());
    expect(eventos.flush).toHaveBeenCalled();
  });

  it('auth consulta con su clave interna el resultado guardado: verificada sí, y sin clave o con otra clave, 401', async () => {
    fetchMock.mockReturnValueOnce(cedulaOk()).mockReturnValueOnce(antecedentesLimpios());
    await request(app.getHttpServer()).post('/kyc/submit').send(solicitud()).expect(201);

    const consulta = await request(app.getHttpServer())
      .get(`/kyc/status/${ANA}`)
      .set('x-internal-key', CLAVE_AUTH)
      .expect(200);
    expect(consulta.body).toEqual({ idUser: ANA, verified: true, nombreCompleto: 'Ana María Pérez' });

    await request(app.getHttpServer()).get(`/kyc/status/${ANA}`).expect(401);
    await request(app.getHttpServer()).get(`/kyc/status/${ANA}`).set('x-internal-key', 'otra-clave').expect(401);

    // Un usuario que nunca se verificó no figura como verificado
    const otro = await request(app.getHttpServer())
      .get(`/kyc/status/${LUIS}`)
      .set('x-internal-key', CLAVE_AUTH)
      .expect(200);
    expect(otro.body).toMatchObject({ verified: false, nombreCompleto: null });
  });

  it('con antecedentes pendientes se rechaza sin aprobación manual posible, se avisa con identity.rejected y no queda verificada', async () => {
    fetchMock
      .mockReturnValueOnce(cedulaOk())
      .mockReturnValueOnce(reply(200, { details: 'REGISTRA ASUNTOS PENDIENTES CON LAS AUTORIDADES JUDICIALES' }));

    const respuesta = await request(app.getHttpServer()).post('/kyc/submit').send(solicitud()).expect(201);

    expect(respuesta.body).toMatchObject({ status: 'rejected', rejectionCode: 'antecedentes_pendientes' });
    expect(tabla.get(ANA)).toMatchObject({ status: 'rejected', rejectionCode: 'antecedentes_pendientes' });
    expect(eventos.publish).toHaveBeenCalledWith(
      'identity.rejected',
      expect.objectContaining({ idUser: ANA, nombreCompleto: 'Ana María Pérez' }),
      expect.anything(),
    );
    expect(eventos.publish).not.toHaveBeenCalledWith('identity.verified', expect.anything(), expect.anything());

    const estado = await request(app.getHttpServer())
      .get(`/kyc/status/${ANA}`)
      .set('x-internal-key', CLAVE_AUTH)
      .expect(200);
    expect(estado.body.verified).toBe(false);
  });

  it('si el nombre no coincide con la Registraduría se rechaza y ni siquiera se consultan los antecedentes', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { data: { fullName: 'MARTA LUCÍA RAMÍREZ', isAlive: true } }));

    const respuesta = await request(app.getHttpServer()).post('/kyc/submit').send(solicitud()).expect(201);

    expect(respuesta.body).toMatchObject({ status: 'rejected', rejectionCode: 'nombre_no_coincide' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('un menor de edad se rechaza con 400 antes de guardar, de llamar a Verifik y de publicar nada', async () => {
    const nacidoHace10Anos = `${new Date().getFullYear() - 10}-01-01`;

    await request(app.getHttpServer())
      .post('/kyc/submit')
      .send(solicitud({ fechaNacimiento: nacidoHace10Anos, fechaExpedicion: '2024-01-01' }))
      .expect(400);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tabla.size).toBe(0);
    expect(eventos.publish).not.toHaveBeenCalled();
  });

  it('un documento ya registrado en otra cuenta es un 409 y no deja un segundo registro', async () => {
    fetchMock.mockReturnValueOnce(cedulaOk()).mockReturnValueOnce(antecedentesLimpios());
    await request(app.getHttpServer()).post('/kyc/submit').send(solicitud()).expect(201);
    fetchMock.mockClear();

    await request(app.getHttpServer())
      .post('/kyc/submit')
      .send(solicitud({ idUser: LUIS, telefono: '3109998877' }))
      .expect(409);

    expect(tabla.size).toBe(1);
    expect(tabla.has(LUIS)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reenviar los datos de un idUser exige el token del primer envío, y con él no se emite otro token', async () => {
    // Primer envío: Verifik no confirma los antecedentes y queda rechazada, con su token
    fetchMock.mockReturnValueOnce(cedulaOk()).mockReturnValueOnce(reply(200, {}));
    const primero = await request(app.getHttpServer()).post('/kyc/submit').send(solicitud()).expect(201);
    expect(primero.body.rejectionCode).toBe('antecedentes_no_confirmados');
    const token = primero.body.submissionToken as string;

    // Sin token, o con uno ajeno: 403 y nada cambia
    await request(app.getHttpServer()).post('/kyc/submit').send(solicitud()).expect(403);
    await request(app.getHttpServer())
      .post('/kyc/submit')
      .send(solicitud({ submissionToken: 'f'.repeat(64) }))
      .expect(403);
    expect(tabla.get(ANA)).toMatchObject({ status: 'rejected' });

    // Con el token correcto el reenvío se evalúa de nuevo y esta vez se aprueba
    fetchMock.mockReset();
    fetchMock.mockReturnValueOnce(cedulaOk()).mockReturnValueOnce(antecedentesLimpios());
    const segundo = await request(app.getHttpServer())
      .post('/kyc/submit')
      .send(solicitud({ submissionToken: token }))
      .expect(201);
    expect(segundo.body.status).toBe('verified');
    expect(segundo.body.submissionToken).toBeUndefined();
  });

  it('si Verifik no responde, la persona recibe 503 (no se la culpa) y no se guarda ni se publica nada', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await request(app.getHttpServer()).post('/kyc/submit').send(solicitud()).expect(503);

    expect(tabla.size).toBe(0);
    expect(eventos.publish).not.toHaveBeenCalled();
  });

  it('un cuerpo con datos mal formados se rechaza con 400 sin tocar a Verifik', async () => {
    await request(app.getHttpServer())
      .post('/kyc/submit')
      .send(solicitud({ idUser: 'no-es-uuid', numeroDocumento: '12ab', fechaNacimiento: '01/01/1990' }))
      .expect(400);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
