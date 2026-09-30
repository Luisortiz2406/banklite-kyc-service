import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqplib from 'amqplib';

const RECONNECT_DELAY_MS = 5000;

/**
 * Publica eventos de dominio en el exchange 'banklite.events' (RabbitMQ),
 * tal como define el documento (5.2 Eventos Asíncronos).
 *
 * KYC Service asume aquí el rol del Identity Service para el evento
 * identity.verified: cuando una verificación de identidad queda aprobada,
 * este servicio publica identity.verified y Account Service lo consume
 * para activar la cuenta pendiente (3.3 del documento).
 *
 * Si RabbitMQ no está disponible, el servicio sigue funcionando en modo
 * "degradado": los eventos solo se registran en log, para no bloquear
 * el flujo transaccional principal (envío de datos de KYC). Mientras tanto se
 * reintenta la conexión en segundo plano, también si se cae después de arrancar.
 */
@Injectable()
export class EventPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EventPublisher[kyc-service]');
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private readonly exchange: string;

  constructor(private readonly config: ConfigService) {
    this.exchange = this.config.get<string>('RABBITMQ_EXCHANGE', 'banklite.events');
  }

  async onModuleInit() {
    await this.connect();
  }

  private async connect() {
    if (this.destroyed) return;
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      this.logger.warn('RABBITMQ_URL no configurada. Eventos solo se registrarán en log.');
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
      const channel = await connection.createChannel();
      channel.on('error', (err) => this.logger.warn(`Error en el canal de RabbitMQ: ${err.message}`));
      channel.on('close', () => {
        this.channel = null;
        // Un canal cerrado con la conexión viva no se recupera solo: se reinicia todo.
        if (!this.destroyed) connection.close().catch(() => undefined);
      });
      await channel.assertExchange(this.exchange, 'topic', { durable: true });
      this.channel = channel;
      this.logger.log(`Conectado a RabbitMQ, exchange '${this.exchange}' listo.`);
    } catch (err) {
      this.logger.warn(
        `No se pudo conectar a RabbitMQ (${(err as Error).message}). Modo degradado; reintentando en ${RECONNECT_DELAY_MS / 1000}s.`,
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
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  async publish(routingKey: string, payload: Record<string, unknown>) {
    const message = {
      event: routingKey,
      occurredAt: new Date().toISOString(),
      data: payload,
    };

    if (!this.channel) {
      this.logger.log(`[degradado] evento '${routingKey}': ${JSON.stringify(message)}`);
      return;
    }

    try {
      this.channel.publish(
        this.exchange,
        routingKey,
        Buffer.from(JSON.stringify(message)),
        { persistent: true, contentType: 'application/json' },
      );
      this.logger.log(`Evento publicado: ${routingKey}`);
    } catch (err) {
      this.logger.warn(`[degradado] no se pudo publicar '${routingKey}': ${(err as Error).message}`);
    }
  }
}
