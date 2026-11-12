import { ForbiddenException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';

const guardsOf = (target: object) => Reflect.getMetadata('__guards__', target) ?? [];
const ANA = '11111111-1111-4111-8111-111111111111';
const LUIS = '22222222-2222-4222-8222-222222222222';

describe('KycController', () => {
  const service = {
    submit: jest.fn().mockResolvedValue({ status: 'verified' }),
    updateContact: jest.fn().mockResolvedValue({}),
    getIdentityStatus: jest.fn().mockResolvedValue({ verified: true, nombreCompleto: 'Ana Pérez' }),
    findByUser: jest.fn().mockResolvedValue({ idUser: ANA }),
  };
  const controller = new KycController(service as unknown as KycService);

  it('el envío del registro es público; el contacto y el estado exigen la clave interna; la consulta, sesión', () => {
    expect(guardsOf(KycController.prototype.submit)).toEqual([]);
    expect(guardsOf(KycController.prototype.updateContact)).toContain(InternalKeyGuard);
    expect(guardsOf(KycController.prototype.status)).toContain(InternalKeyGuard);
    expect(guardsOf(KycController.prototype.findOne)).toContain(JwtAuthGuard);
  });

  it('submit y updateContact delegan en el servicio', async () => {
    const body = { idUser: ANA } as never;
    expect(await controller.submit(body)).toEqual({ status: 'verified' });
    expect(service.submit).toHaveBeenCalledWith(body);
    await controller.updateContact(body);
    expect(service.updateContact).toHaveBeenCalledWith(body);
  });

  it('status responde con el idUser y si está verificada', async () => {
    expect(await controller.status(ANA)).toEqual({ idUser: ANA, verified: true, nombreCompleto: 'Ana Pérez' });
  });

  it('un cliente solo consulta SU verificación; la de otro da 403', async () => {
    const request = (idUser: string) => ({ user: { idUser } }) as never;

    expect(await controller.findOne(ANA, request(ANA))).toEqual({ idUser: ANA });
    await expect(controller.findOne(LUIS, request(ANA))).rejects.toThrow(ForbiddenException);
    expect(service.findByUser).toHaveBeenCalledTimes(1);
  });
});

describe('SubmitKycDto', () => {
  const valid = {
    idUser: ANA,
    nombres: 'Ana',
    apellidos: 'Pérez',
    tipoDocumento: 'CC',
    numeroDocumento: '1000000001',
    fechaNacimiento: '1990-01-01',
    fechaExpedicion: '2010-01-01',
  };
  const errorsOf = async (over: Record<string, unknown>) =>
    (await validate(plainToInstance(SubmitKycDto, { ...valid, ...over }))).map((e) => e.property);

  it('acepta los datos del registro, con correo, teléfono y token opcionales', async () => {
    expect(await errorsOf({})).toEqual([]);
    expect(await errorsOf({ email: 'ana@example.com', telefono: '300', submissionToken: 'x' })).toEqual([]);
  });

  it('rechaza id que no es UUID, documento con letras, tipo desconocido, fechas mal escritas y correo inválido', async () => {
    expect(await errorsOf({ idUser: 'abc' })).toEqual(['idUser']);
    expect(await errorsOf({ numeroDocumento: '12ab' })).toEqual(['numeroDocumento']);
    expect(await errorsOf({ tipoDocumento: 'TI' })).toEqual(['tipoDocumento']);
    expect(await errorsOf({ fechaNacimiento: '01/01/1990' })).toEqual(['fechaNacimiento']);
    expect(await errorsOf({ fechaExpedicion: '2010-02-31' })).toEqual(['fechaExpedicion']);
    expect(await errorsOf({ email: 'no-es-correo' })).toEqual(['email']);
    expect(await errorsOf({ nombres: 'A' })).toEqual(['nombres']);
  });
});
