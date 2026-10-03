import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Patrón outbox: cada evento se guarda primero en esta tabla y luego se publica
 * en RabbitMQ. Si RabbitMQ está caído, el evento espera aquí y se reintenta en
 * segundo plano; nunca se pierde. occurred_at queda fijo para que los
 * consumidores dedupliquen las reentregas (entrega at-least-once).
 */
@Entity('event_outbox')
@Index('idx_event_outbox_pending', ['publishedAt', 'createdAt'])
export class EventOutbox {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'routing_key', type: 'varchar' })
  routingKey: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
