import {
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MinLength,
} from 'class-validator';

const TIPOS_DOCUMENTO = ['CC', 'CE', 'PA'];

/**
 * Coincide con el objeto `state.kyc` que arma el frontend en el paso
 * "Confirma tu identidad" del registro (fechas en formato yyyy-mm-dd, el
 * mismo que entrega <input type="date">).
 *
 * `email` y `telefono` son opcionales aquí a propósito: la identidad
 * (Verifik + Truora) se verifica justo después de los datos personales,
 * antes de que el usuario haya confirmado su correo o su teléfono. Esos dos
 * datos se completan más adelante en el flujo (Auth Service) y no son
 * necesarios para validar el documento de identidad.
 */
export class SubmitKycDto {
  @IsUUID()
  idUser: string;

  @IsString()
  @MinLength(2)
  nombres: string;

  @IsString()
  @MinLength(2)
  apellidos: string;

  @IsIn(TIPOS_DOCUMENTO, {
    message: `tipoDocumento debe ser una de: ${TIPOS_DOCUMENTO.join(', ')}`,
  })
  tipoDocumento: string;

  @IsString()
  @Matches(/^\d+$/, { message: 'numeroDocumento debe contener solo dígitos' })
  numeroDocumento: string;

  @IsISO8601({ strict: true }, { message: 'fechaNacimiento debe tener formato yyyy-mm-dd' })
  fechaNacimiento: string;

  @IsISO8601({ strict: true }, { message: 'fechaExpedicion debe tener formato yyyy-mm-dd' })
  fechaExpedicion: string;

  @IsOptional()
  @IsEmail({}, { message: 'email debe ser un correo válido' })
  email?: string;

  @IsOptional()
  @IsString()
  telefono?: string;
}
