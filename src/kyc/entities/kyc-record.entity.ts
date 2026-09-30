import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Tabla kyc_records.
 * id_user es una FK lógica (UUID) al Identity/Auth Service, sin join físico
 * entre bases de datos (4.10 Integridad de Datos sin Joins entre Microservicios).
 *
 * Este microservicio reemplaza el "KYC local" que antes vivía únicamente en
 * el navegador (localStorage) del frontend: ahora los datos personales viajan
 * al backend y, al quedar verificados, se publica el evento identity.verified
 * que Account Service consume para activar la cuenta.
 */
@Entity('kyc_records')
export class KycRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Column()
  nombres: string;

  @Column()
  apellidos: string;

  @Column({ name: 'tipo_documento' })
  tipoDocumento: string; // CC | CE | PA

  @Index({ unique: true })
  @Column({ name: 'numero_documento' })
  numeroDocumento: string;

  @Column({ name: 'fecha_nacimiento', type: 'date' })
  fechaNacimiento: string;

  @Column({ name: 'fecha_expedicion', type: 'date' })
  fechaExpedicion: string;

  // type explícito: con strictNullChecks, `string | null` se emite como "Object" y TypeORM
  // (postgres) aborta el arranque con DataTypeNotSupportedError.
  @Column({ type: 'varchar', nullable: true })
  email: string | null;

  @Index({ unique: true })
  @Column({ type: 'varchar', nullable: true })
  telefono: string | null;

  @Column({
    type: 'varchar',
    default: 'verified',
  })
  status: 'verified' | 'rejected';

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
