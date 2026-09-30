import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqplib from 'amqplib';

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
 * el flujo transaccional principal (envío de datos de KYC).
 */
@Injectable()
export class EventPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EventPublisher[kyc-service]');
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private readonly exchange: string;

  constructor(private readonly config: ConfigService) {
    this.exchange = this.config.get<string>('RABBITMQ_EXCHANGE', 'banklite.events');
  }

  async onModuleInit() {
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      this.logger.warn('RABBITMQ_URL no configurada. Eventos solo se registrarán en log.');
      return;
    }
    try {
      this.connection = await amqplib.connect(url);
      this.channel = await this.connection.createChannel();
      await this.channel.assertExchange(this.exchange, 'topic', { durable: true });
      this.logger.log(`Conectado a RabbitMQ, exchange '${this.exchange}' listo.`);
    } catch (err) {
      this.logger.warn(
        `No se pudo conectar a RabbitMQ (${(err as Error).message}). Continuando en modo degradado.`,
      );
      this.connection = null;
      this.channel = null;
    }
  }

  async onModuleDestroy() {
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

    this.channel.publish(
      this.exchange,
      routingKey,
      Buffer.from(JSON.stringify(message)),
      { persistent: true, contentType: 'application/json' },
    );
    this.logger.log(`Evento publicado: ${routingKey}`);
  }
}
