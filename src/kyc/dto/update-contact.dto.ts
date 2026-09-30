import { IsEmail, IsOptional, IsString, IsUUID } from 'class-validator';

export class UpdateContactDto {
  @IsUUID()
  idUser: string;

  @IsOptional()
  @IsEmail({}, { message: 'email debe ser un correo válido' })
  email?: string;

  @IsOptional()
  @IsString()
  telefono?: string;
}
