import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { encryptedColumn } from '../../common/crypto/field-crypto';

/**
 * Tabla kyc_records.
 * id_user es una FK lógica (UUID) al Identity/Auth Service, sin join físico
 * entre bases de datos (4.10 Integridad de Datos sin Joins entre Microservicios).
 *
 * Este microservicio reemplaza el "KYC local" que antes vivía únicamente en
 * el navegador (localStorage) del frontend: ahora los datos personales viajan
 * al backend y, al quedar verificados, se publica el evento identity.verified
 * que Account Service consume para activar la cuenta.
 *
 * Documento, fechas y teléfono se guardan cifrados (AES-256-GCM, ver
 * field-crypto.ts). Para unicidad y búsqueda exacta se usan los índices ciegos
 * numero_documento_hash y telefono_hash, que asigna KycService al guardar.
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

  @Column({ name: 'numero_documento', type: 'varchar', transformer: encryptedColumn })
  numeroDocumento: string;

  @Index({ unique: true })
  @Column({ name: 'numero_documento_hash', type: 'varchar', length: 64, nullable: true, select: false })
  numeroDocumentoHash: string | null;

  // 'YYYY-MM-DD' cifrado (antes era una columna date).
  @Column({ name: 'fecha_nacimiento', type: 'varchar', transformer: encryptedColumn })
  fechaNacimiento: string;

  @Column({ name: 'fecha_expedicion', type: 'varchar', transformer: encryptedColumn })
  fechaExpedicion: string;

  // type explícito: con strictNullChecks, `string | null` se emite como "Object" y TypeORM
  // (postgres) aborta el arranque con DataTypeNotSupportedError.
  @Column({ type: 'varchar', nullable: true })
  email: string | null;

  @Column({ type: 'varchar', nullable: true, transformer: encryptedColumn })
  telefono: string | null;

  @Index({ unique: true })
  @Column({ name: 'telefono_hash', type: 'varchar', length: 64, nullable: true, select: false })
  telefonoHash: string | null;

  @Column({
    type: 'varchar',
    default: 'verified',
  })
  status: 'verified' | 'rejected';

  // Hash SHA-256 del token que se entrega al primer envío de /kyc/submit.
  // Los reenvíos para el mismo idUser deben presentarlo, así nadie más puede
  // sobrescribir los datos de otra persona. select:false: nunca sale en respuestas.
  @Column({ name: 'submission_token_hash', type: 'varchar', nullable: true, select: false })
  submissionTokenHash: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
