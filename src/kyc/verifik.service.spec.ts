import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VerifikService } from './verifik.service';

/**
 * Verifik (fetch simulado: estas pruebas nunca llaman al proveedor real). En modo demo todo
 * se aprueba sin consultar; en modo live solo se aprueba lo que la fuente oficial confirma,
 * y si el proveedor falla se responde 503 (no se culpa a la persona).
 */
const reply = (status: number, body: unknown = {}) =>
  Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response);

describe('VerifikService', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  const live = { VERIFIK_MODE: 'live', VERIFIK_API_KEY: 'token-de-prueba' };
  const build = (env: Record<string, string> = {}) => new VerifikService(new ConfigService(env));

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  describe('modo demo (por defecto)', () => {
    it('aprueba documento y antecedentes sin llamar a Verifik', async () => {
      const service = build();

      expect(await service.verifyDocument('1000000001', 'CC', 'Ana Pérez')).toMatchObject({
        matched: true,
        provider: 'verifik-demo',
        nombreCompleto: 'Ana Pérez',
      });
      expect(await service.verifyAntecedentes('1000000001', 'CC')).toMatchObject({
        cleared: true,
        provider: 'verifik-antecedentes-demo',
        nivelRiesgo: 'bajo',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('los antecedentes pueden ir en demo aunque el documento esté en live, y al revés no', async () => {
      const mixed = build({ ...live, VERIFIK_ANTECEDENTES_MODE: 'demo' });
      expect((await mixed.verifyAntecedentes('1', 'CC')).provider).toBe('verifik-antecedentes-demo');

      fetchMock.mockReturnValue(reply(200, { details: 'NO TIENE ASUNTOS PENDIENTES' }));
      const antecedentesLive = build({ VERIFIK_MODE: 'demo', VERIFIK_ANTECEDENTES_MODE: 'live', VERIFIK_API_KEY: 'k' });
      expect((await antecedentesLive.verifyAntecedentes('1', 'CC')).provider).toBe('verifik-antecedentes');
    });
  });

  describe('documento en modo live', () => {
    const cedula = (data: Record<string, unknown>, status = 200) => fetchMock.mockReturnValue(reply(status, { data }));

    it('consulta con el token, el tipo y el número, y aprueba si el nombre coincide', async () => {
      cedula({ fullName: 'ANA MARÍA PÉREZ GÓMEZ' });

      const result = await build({ ...live, VERIFIK_API_URL: 'http://verifik.falso/cedula' }).verifyDocument(
        '1000000001',
        'CC',
        'ana perez',
      );

      expect(result).toEqual({ matched: true, provider: 'verifik', nombreCompleto: 'ANA MARÍA PÉREZ GÓMEZ' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('http://verifik.falso/cedula?documentType=CC&documentNumber=1000000001');
      expect(init.headers.Authorization).toBe('jwt token-de-prueba');
    });

    it('el esquema de autorización se puede cambiar a Bearer', async () => {
      cedula({ fullName: 'ANA PEREZ' });
      await build({ ...live, VERIFIK_AUTH_SCHEME: 'Bearer' }).verifyDocument('1', 'CC', 'Ana Perez');
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer token-de-prueba');
    });

    it('rechaza (aprobable a mano) un tipo de documento que la fuente no consulta, sin llamar', async () => {
      expect(await build(live).verifyDocument('1', 'CE', 'Ana Perez')).toMatchObject({
        matched: false,
        code: 'documento_tipo_no_soportado',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('un documento que la fuente no encuentra (404 o sin data) se rechaza como no encontrado', async () => {
      fetchMock.mockReturnValueOnce(reply(404, { message: 'not found' }));
      expect(await build(live).verifyDocument('1', 'CC', 'Ana')).toMatchObject({
        matched: false,
        code: 'documento_no_encontrado',
        nombreCompleto: null,
      });
      fetchMock.mockReturnValueOnce(reply(200, {}));
      expect((await build(live).verifyDocument('1', 'CC', 'Ana')).code).toBe('documento_no_encontrado');
    });

    it('sin nombre en la respuesta se rechaza como sin nombre', async () => {
      cedula({ fullName: '   ' });
      expect(await build(live).verifyDocument('1', 'CC', 'Ana')).toMatchObject({
        matched: false,
        code: 'documento_sin_nombre',
      });
    });

    it('REGLA DURA: un documento que figura como no vigente nunca se aprueba, aunque el nombre coincida', async () => {
      cedula({ fullName: 'ANA PEREZ', isAlive: false });

      expect(await build(live).verifyDocument('1', 'CC', 'Ana Perez')).toMatchObject({
        matched: false,
        code: 'documento_no_vigente',
        nombreCompleto: 'ANA PEREZ',
      });
    });

    it('un nombre distinto se rechaza: cada palabra escrita debe estar en el nombre oficial', async () => {
      cedula({ fullName: 'ANA MARIA PEREZ GOMEZ' });

      expect((await build(live).verifyDocument('1', 'CC', 'Ana Gomez')).matched).toBe(true);
      expect(await build(live).verifyDocument('1', 'CC', 'Ana Rojas')).toMatchObject({
        matched: false,
        code: 'nombre_no_coincide',
      });
      expect((await build(live).verifyDocument('1', 'CC', '  123 ')).matched).toBe(false);
    });

    it('VERIFIK_SKIP_NAME_CHECK=true (solo sandbox) omite la comparación del nombre', async () => {
      cedula({ fullName: 'OTRA PERSONA' });
      expect(
        (await build({ ...live, VERIFIK_SKIP_NAME_CHECK: 'true' }).verifyDocument('1', 'CC', 'Ana Perez')).matched,
      ).toBe(true);
    });
  });

  describe('antecedentes en modo live', () => {
    const policia = (body: unknown, status = 200) => fetchMock.mockReturnValue(reply(status, body));

    it('aprueba solo si la leyenda EMPIEZA con "no tiene asuntos pendientes" (sin importar tildes o mayúsculas)', async () => {
      policia({ details: 'No tiene asuntos pendientes con las autoridades judiciales' });
      expect(await build(live).verifyAntecedentes('1', 'CC')).toEqual({
        cleared: true,
        provider: 'verifik-antecedentes',
        nivelRiesgo: 'bajo',
        alertas: [],
      });

      policia({ data: { legend: 'NO TIENE ASUNTOS PENDIENTES' } });
      expect((await build(live).verifyAntecedentes('1', 'CE')).cleared).toBe(true);
      policia({ data: { details: 'no tiene asuntos pendientes' } });
      expect((await build(live).verifyAntecedentes('1', 'CC')).cleared).toBe(true);
    });

    it('REGLA DURA: con antecedentes pendientes no se aprueba, aunque el texto legal mencione la leyenda', async () => {
      policia({
        details:
          'REGISTRA ASUNTOS PENDIENTES. Conforme a la ley, quien NO TIENE ASUNTOS PENDIENTES recibe otro mensaje.',
      });

      const result = await build(live).verifyAntecedentes('1', 'CC');

      expect(result).toMatchObject({ cleared: false, code: 'antecedentes_pendientes', nivelRiesgo: 'alto' });
      expect(result.alertas).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('Conforme a la ley');
    });

    it('una respuesta que no se puede interpretar nunca se toma como limpia', async () => {
      policia({});
      expect(await build(live).verifyAntecedentes('1', 'CC')).toMatchObject({
        cleared: false,
        code: 'antecedentes_no_confirmados',
        nivelRiesgo: 'desconocido',
      });
      policia({ details: 'NO TIENE ASUNTOS PENDIENTES' }, 404);
      expect((await build(live).verifyAntecedentes('1', 'CC')).code).toBe('antecedentes_no_confirmados');
    });

    it('un tipo de documento que la Policía no consulta se rechaza (aprobable a mano) sin llamar', async () => {
      expect(await build(live).verifyAntecedentes('1', 'PPT')).toMatchObject({
        cleared: false,
        code: 'antecedentes_tipo_no_soportado',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('fallas del proveedor: 503, no un rechazo de la persona', () => {
    it('sin VERIFIK_API_KEY en modo live no sale la llamada', async () => {
      await expect(build({ VERIFIK_MODE: 'live' }).verifyDocument('1', 'CC', 'Ana')).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([401, 402, 403, 429, 500, 503])('un %i del proveedor da 503', async (status) => {
      fetchMock.mockReturnValue(reply(status, { message: 'x' }));
      await expect(build(live).verifyDocument('1', 'CC', 'Ana')).rejects.toThrow(ServiceUnavailableException);
      await expect(build(live).verifyAntecedentes('1', 'CC')).rejects.toThrow(ServiceUnavailableException);
    });

    it('si Verifik no responde (red o tiempo agotado) da 503', async () => {
      fetchMock.mockRejectedValue(new Error('timeout'));
      await expect(build(live).verifyDocument('1', 'CC', 'Ana')).rejects.toThrow(
        'No se pudo contactar a Verifik. Intenta de nuevo.',
      );
    });

    it('una respuesta que no es JSON se trata como vacía', async () => {
      fetchMock.mockReturnValue(
        Promise.resolve({ status: 200, ok: true, json: async () => Promise.reject(new Error('no json')) }),
      );
      expect((await build(live).verifyDocument('1', 'CC', 'Ana')).code).toBe('documento_no_encontrado');
    });
  });
});
