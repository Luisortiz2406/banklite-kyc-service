import * as amqplib from 'amqplib';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { EventPublisherService } from './event-publisher.service';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

/**
 * Publicador de eventos de kyc (RabbitMQ y base simulados). Sin RabbitMQ el servicio sigue arriba y
 * los eventos esperan en el outbox; el relevo publica con confirmación del broker, cuenta los
 * intentos fallidos y no pierde los eventos que siguen.
 */
function fakeBroker() {
  const handlers: {
    connection: Record<string, (...args: any[]) => void>;
    channel: Record<string, (...args: any[]) => void>;
  } = { connection: {}, channel: {} };
  const channel = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => (handlers.channel[event] = handler)),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockReturnValue(true),
    waitForConfirms: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const connection = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => (handlers.connection[event] = handler)),
    createConfirmChannel: jest.fn().mockResolvedValue(channel),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { channel, connection, handlers };
}

/** Base simulada: guarda el evento en el outbox y el relevo lee los pendientes, publica y marca. */
function fakeDatabase(pending: any[] = []) {
  const saved: any[] = [];
  const manager: any = {
    save: jest.fn(async (row: any) => row),
    createQueryBuilder: jest.fn(() => {
      const qb: any = {};
      for (const method of ['setLock', 'setOnLocked', 'where', 'orderBy', 'limit']) qb[method] = jest.fn(() => qb);
      qb.getMany = jest.fn(async () => pending.filter((row) => !row.publishedAt));
      return qb;
    }),
    getRepository: jest.fn(() => ({
      create: (row: any) => ({ ...row }),
      save: jest.fn(async (row: any) => {
        saved.push(row);
        return row;
      }),
    })),
  };
  const dataSource: any = {
    manager,
    saved,
    query: jest.fn().mockResolvedValue([[], 0]),
    transaction: jest.fn(async (cb: any) => cb(manager)),
  };
  return dataSource;
}
const outboxRow = (over: Record<string, unknown> = {}): any => ({
  id: 'e1',
  routingKey: 'identity.verified',
  payload: { idUser: 'u1' },
  occurredAt: new Date('2026-11-11T15:00:00.000Z'),
  attempts: 0,
  lastError: null,
  publishedAt: null,
  ...over,
});

/** Deja terminar el relevo que arranca solo al conectar. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe('EventPublisherService de kyc', () => {
  const connect = amqplib.connect as unknown as jest.Mock;
  let broker: ReturnType<typeof fakeBroker>;
  let db: ReturnType<typeof fakeDatabase>;
  const build = (env: Record<string, string> = { RABBITMQ_URL: 'amqp://rabbit' }) =>
    new EventPublisherService(new ConfigService(env), db as unknown as DataSource);

  beforeEach(() => {
    jest.clearAllMocks();
    broker = fakeBroker();
    db = fakeDatabase();
    connect.mockResolvedValue(broker.connection);
  });
  afterEach(() => jest.useRealTimers());

  describe('conexión con RabbitMQ', () => {
    it('sin RABBITMQ_URL no conecta; los eventos esperan en el outbox', async () => {
      const publisher = build({});
      await publisher.onModuleInit();

      expect(connect).not.toHaveBeenCalled();
      db.query.mockResolvedValue([{ pending: 1 }]);
      expect((await publisher.stats()).brokerConnected).toBe(false);
      await publisher.onModuleDestroy();
    });

    it('al conectar declara el exchange durable y el estado lo refleja', async () => {
      const publisher = build({ RABBITMQ_URL: 'amqp://rabbit', RABBITMQ_EXCHANGE: 'otro.exchange' });
      await publisher.onModuleInit();
      db.query.mockResolvedValue([{ pending: 2, failing: 0 }]);

      expect(broker.channel.assertExchange).toHaveBeenCalledWith('otro.exchange', 'topic', { durable: true });
      expect(await publisher.stats()).toEqual({ pending: 2, failing: 0, brokerConnected: true });
      await publisher.onModuleDestroy();
    });

    it('si RabbitMQ no está, reintenta a los 5 s; si el canal falla, cierra la conexión colgada y reintenta', async () => {
      jest.useFakeTimers();
      connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      broker.connection.createConfirmChannel.mockRejectedValueOnce(new Error('canal'));
      const publisher = build();

      await publisher.onModuleInit();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(broker.connection.close).toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(connect).toHaveBeenCalledTimes(3);
      db.query.mockResolvedValue([{}]);
      expect((await publisher.stats()).brokerConnected).toBe(true);
      await publisher.onModuleDestroy();
    });

    it('si la conexión se cae reconecta; los errores solo se registran; cerrar el módulo cancela el reintento', async () => {
      jest.useFakeTimers();
      const publisher = build();
      await publisher.onModuleInit();

      expect(() => broker.handlers.connection.error(new Error('x'))).not.toThrow();
      expect(() => broker.handlers.channel.error(new Error('x'))).not.toThrow();
      broker.handlers.channel.close();
      expect(broker.connection.close).toHaveBeenCalled();
      broker.handlers.connection.close();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(connect).toHaveBeenCalledTimes(2);

      await publisher.onModuleDestroy();
      broker.handlers.connection.close();
      await jest.advanceTimersByTimeAsync(20_000);
      expect(connect).toHaveBeenCalledTimes(2);
    });
  });

  describe('limpieza del outbox al arrancar', () => {
    it('reduce los identity.verified antiguos al idUser', async () => {
      db.query.mockResolvedValueOnce([[], 3]);
      const publisher = build({});
      await publisher.onModuleInit();

      const sql = String(db.query.mock.calls[0][0]);
      expect(sql).toContain("routing_key = 'identity.verified'");
      expect(sql).toContain("jsonb_build_object('idUser'");
      await publisher.onModuleDestroy();
    });

    it('si la limpieza falla, el servicio arranca igual', async () => {
      db.query.mockRejectedValueOnce(new Error('sin tabla'));
      const publisher = build({});
      await expect(publisher.onModuleInit()).resolves.toBeUndefined();
      await publisher.onModuleDestroy();
    });
  });

  describe('publish (outbox)', () => {
    it('con la transacción del llamador guarda el evento ahí y no lanza el relevo', async () => {
      const save = jest.fn(async (row: any) => row);
      const manager = { getRepository: () => ({ create: (row: any) => row, save }) } as never;

      await build().publish('identity.verified', { idUser: 'u1' }, manager);

      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ routingKey: 'identity.verified', payload: { idUser: 'u1' } }),
      );
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('sin transacción lo guarda en la base y lanza el relevo de inmediato', async () => {
      const publisher = build();
      await publisher.onModuleInit();

      await publisher.publish('identity.rejected', { idUser: 'u1' });
      await new Promise((resolve) => setImmediate(resolve));

      expect(db.saved[0]).toMatchObject({ routingKey: 'identity.rejected', payload: { idUser: 'u1' } });
      expect(db.transaction).toHaveBeenCalled();
      await publisher.onModuleDestroy();
    });
  });

  describe('flush (relevo del outbox)', () => {
    it('sin conexión no toca la base', async () => {
      await build({}).flush();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('publica los pendientes persistentes, con confirmación, y los marca como publicados', async () => {
      const rows: any[] = [];
      db = fakeDatabase(rows);
      const publisher = build();
      await publisher.onModuleInit();
      await settle();
      rows.push(outboxRow({ id: 'e1' }), outboxRow({ id: 'e2', routingKey: 'identity.rejected' }));
      await publisher.flush();

      const [exchange, routingKey, content, options] = broker.channel.publish.mock.calls[0];
      expect(exchange).toBe('banklite.events');
      expect(routingKey).toBe('identity.verified');
      expect(JSON.parse(content.toString())).toEqual({
        event: 'identity.verified',
        occurredAt: '2026-11-11T15:00:00.000Z',
        data: { idUser: 'u1' },
      });
      expect(options).toMatchObject({ persistent: true, contentType: 'application/json', messageId: 'e1' });
      expect(rows.every((r) => r.publishedAt instanceof Date)).toBe(true);
      expect(broker.channel.publish).toHaveBeenCalledTimes(2);
      await publisher.onModuleDestroy();
    });

    it('si el broker no confirma, cuenta el intento, guarda el error y se detiene sin perder los demás', async () => {
      const rows: any[] = [];
      db = fakeDatabase(rows);
      const publisher = build();
      await publisher.onModuleInit();
      await settle();
      rows.push(outboxRow({ id: 'e1' }), outboxRow({ id: 'e2' }));
      broker.channel.waitForConfirms.mockRejectedValueOnce(new Error('x'.repeat(900)));
      await publisher.flush();

      expect(rows[0]).toMatchObject({ attempts: 1, publishedAt: null });
      expect(rows[0].lastError).toHaveLength(500);
      expect(rows[1]).toMatchObject({ attempts: 0, publishedAt: null });
      expect(broker.channel.publish).toHaveBeenCalledTimes(1);
      await publisher.onModuleDestroy();
    });

    it('un lote lleno sigue con el siguiente y un error de la base no tumba al servicio', async () => {
      const full: any[] = [];
      db = fakeDatabase(full);
      const publisher = build();
      await publisher.onModuleInit();
      await settle();
      full.push(...Array.from({ length: 50 }, (_, i) => outboxRow({ id: `e${i}` })));
      db.transaction.mockClear();
      await publisher.flush();
      expect(db.transaction.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(full.every((r) => r.publishedAt)).toBe(true);

      db.transaction.mockRejectedValueOnce(new Error('base caída'));
      await expect(publisher.flush()).resolves.toBeUndefined();
      await publisher.onModuleDestroy();
    });

    it('dos relevos a la vez no se pisan', async () => {
      const publisher = build();
      await publisher.onModuleInit();
      await settle();
      db.transaction.mockClear();
      let release!: () => void;
      db.transaction.mockImplementationOnce(() => new Promise<boolean>((resolve) => (release = () => resolve(false))));

      const first = publisher.flush();
      await publisher.flush();
      expect(db.transaction).toHaveBeenCalledTimes(1);
      release();
      await first;
      await publisher.onModuleDestroy();
    });

    it('el relevo corre solo cada 5 s', async () => {
      jest.useFakeTimers();
      const publisher = build();
      await publisher.onModuleInit();
      db.transaction.mockClear();

      await jest.advanceTimersByTimeAsync(5_000);

      expect(db.transaction).toHaveBeenCalled();
      await publisher.onModuleDestroy();
    });
  });
});
