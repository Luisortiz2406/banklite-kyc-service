import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import * as amqplib from 'amqplib';
import { DataSource, EntityManager } from 'typeorm';
import { EventOutbox } from './event-outbox.entity';

const RECONNECT_DELAY_MS = 5000;
const RELAY_INTERVAL_MS = 5000;
const BATCH_SIZE = 50;

/**
 * Publica eventos de dominio en el exchange 'banklite.events' (RabbitMQ),
 * tal como define el documento (5.2 Eventos Asíncronos).
 *
 * KYC Service asume aquí el rol del Identity Service para el evento
 * identity.verified: cuando una verificación de identidad queda aprobada,
 * este servicio publica identity.verified y Account Service lo consume
 * para activar la cuenta pendiente (3.3 del documento).
 *
 * Patrón outbox: publish() guarda el evento en event_outbox y un relevo lo
 * envía con confirmación del broker. Si RabbitMQ no está disponible, el
 * servicio sigue funcionando (el envío de datos de KYC no se bloquea) y los eventos
 * esperan en la tabla hasta que vuelva la conexión, que se reintenta en
 * segundo plano.
 */
@Injectable()
export class EventPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EventPublisher[kyc-service]');
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.ConfirmChannel | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private relayTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private destroyed = false;
  private readonly exchange: string;

  constructor(
    private readonly config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    this.exchange = this.config.get<string>('RABBITMQ_EXCHANGE', 'banklite.events');
  }

  async onModuleInit() {
    await this.scrubIdentityPayloads();
    this.relayTimer = setInterval(() => void this.flush(), RELAY_INTERVAL_MS);
    await this.connect();
  }

  /**
   * Versiones anteriores publicaban identity.verified con documento, nombre,
   * nivel de riesgo y alertas en claro, y quedaban así en event_outbox. Se
   * reducen al idUser (lo único que necesitan los consumidores). Idempotente.
   */
  private async scrubIdentityPayloads() {
    try {
      const [, affected] = await this.dataSource.query(
        `UPDATE event_outbox
            SET payload = jsonb_build_object('idUser', payload->'idUser')
          WHERE routing_key = 'identity.verified'
            AND payload - 'idUser' <> '{}'::jsonb`,
      );
      if (affected)
        this.logger.log(`Datos personales eliminados de ${affected} evento(s) identity.verified del outbox.`);
    } catch (err) {
      this.logger.warn(`No se pudo limpiar el outbox: ${(err as Error).message}`);
    }
  }

  private async connect() {
    if (this.destroyed) return;
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      this.logger.warn('RABBITMQ_URL no configurada. Los eventos quedarán en el outbox.');
      return;
    }
    try {
      const connection = await amqplib.connect(url);
      this.connection = connection;
      // Sin listener de 'error', un fallo de la conexión tumbaría el proceso.
      connection.on('error', (err) => this.logger.warn(`Error en la conexión con RabbitMQ: ${err.message}`));
      connection.on('close', () => {
        this.connection = null;
        this.channel = null;
        this.scheduleReconnect();
      });
      const channel = await connection.createConfirmChannel();
      channel.on('error', (err) => this.logger.warn(`Error en el canal de RabbitMQ: ${err.message}`));
      channel.on('close', () => {
        this.channel = null;
        // Un canal cerrado con la conexión viva no se recupera solo: se reinicia todo.
        if (!this.destroyed) connection.close().catch(() => undefined);
      });
      await channel.assertExchange(this.exchange, 'topic', { durable: true });
      this.channel = channel;
      this.logger.log(`Conectado a RabbitMQ, exchange '${this.exchange}' listo.`);
      void this.flush();
    } catch (err) {
      this.logger.warn(
        `No se pudo conectar a RabbitMQ (${(err as Error).message}). Los eventos esperan en el outbox; reintentando en ${RECONNECT_DELAY_MS / 1000}s.`,
      );
      // Si la conexión abrió pero falló el canal, se cierra para no dejarla colgada.
      await this.connection?.close().catch(() => undefined);
      this.connection = null;
      this.channel = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
  }

  async onModuleDestroy() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.relayTimer) clearInterval(this.relayTimer);
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  /**
   * Guarda el evento en el outbox. Con `manager`, se guarda dentro de esa
   * transacción (el evento existe si y solo si el cambio de negocio se
   * confirmó); el llamador debe invocar flush() después del commit. Sin
   * `manager`, se guarda y se publica de inmediato.
   */
  async publish(routingKey: string, payload: Record<string, unknown>, manager?: EntityManager) {
    const repo = (manager ?? this.dataSource.manager).getRepository(EventOutbox);
    await repo.save(repo.create({ routingKey, payload, occurredAt: new Date() }));
    if (!manager) void this.flush();
  }

  /** Estado del outbox para el panel administrativo. */
  async stats() {
    const [row] = await this.dataSource.query(
      `SELECT COUNT(*) FILTER (WHERE published_at IS NULL)::int AS pending,
              MIN(created_at) FILTER (WHERE published_at IS NULL) AS "oldestPending",
              COUNT(*) FILTER (WHERE published_at IS NULL AND attempts > 0)::int AS failing,
              COUNT(*) FILTER (WHERE published_at > now() - interval '24 hours')::int AS "publishedLast24h"
         FROM event_outbox`,
    );
    return { ...row, brokerConnected: this.channel !== null };
  }

  /** Publica los eventos pendientes en orden; se detiene en el primer fallo y reintenta después. */
  async flush() {
    if (this.flushing || !this.channel) return;
    this.flushing = true;
    try {
      let more = true;
      while (more && this.channel) {
        more = await this.dataSource.transaction(async (manager) => {
          // SKIP LOCKED: con varias réplicas, cada evento lo publica solo una.
          const rows = await manager
            .createQueryBuilder(EventOutbox, 'outbox')
            .setLock('pessimistic_write')
            .setOnLocked('skip_locked')
            .where('outbox.published_at IS NULL')
            .orderBy('outbox.created_at', 'ASC')
            .limit(BATCH_SIZE)
            .getMany();

          for (const row of rows) {
            try {
              await this.send(row);
              row.publishedAt = new Date();
              await manager.save(row);
              this.logger.log(`Evento publicado: ${row.routingKey}`);
            } catch (err) {
              row.attempts += 1;
              row.lastError = (err as Error).message.slice(0, 500);
              await manager.save(row);
              this.logger.warn(`No se pudo publicar '${row.routingKey}' (${row.id}); se reintentará: ${row.lastError}`);
              return false;
            }
          }
          return rows.length === BATCH_SIZE;
        });
      }
    } catch (err) {
      this.logger.error(`Error procesando el outbox: ${(err as Error).message}`);
    } finally {
      this.flushing = false;
    }
  }

  private async send(row: EventOutbox) {
    const channel = this.channel;
    if (!channel) throw new Error('RabbitMQ no está conectado');
    const message = { event: row.routingKey, occurredAt: row.occurredAt.toISOString(), data: row.payload };
    channel.publish(this.exchange, row.routingKey, Buffer.from(JSON.stringify(message)), {
      persistent: true,
      contentType: 'application/json',
      messageId: row.id,
    });
    await channel.waitForConfirms();
  }
}
