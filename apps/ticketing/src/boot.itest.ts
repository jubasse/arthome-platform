import { DateScheduledSchema } from '@arthome-platform/events';
import { retryTopic } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  Kafka,
  type Consumer,
  type ConsumerRunConfig,
  type EachMessagePayload,
  type Producer,
  type ProducerRecord,
} from 'kafkajs';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiErrorCode, Service } from '@arthome/core';

/**
 * The three processes' root modules, booted as `main.ts`, `consumer.ts` and `sweeper.ts` boot them,
 * against a real Postgres: a module the root graph misses, or its `CqrsModule.forRoot()` dropped,
 * fails here rather than at a deploy. Kafka is stubbed. The service's modules are imported only
 * once `DATABASE_URL` names the container, since `env.ts` reads it at import.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const DATE_ID = '01a0f100-0000-7000-8000-000000000001';

let stack: StartedStack;
let databaseUrl: string;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_boot_itest');
  process.env.DATABASE_URL = database.url;
  databaseUrl = database.url;
  const { TICKETING_SCHEMA } = await import('./itest/schema.js');
  await (await applyMigrations(database, TICKETING_SCHEMA)).destroy();
}, STARTUP_MS);

afterAll(async () => {
  await stack?.stop();
});

describe('the API process', () => {
  it(
    'boots AppModule, answers its probes and refuses through its own global providers',
    async () => {
      const { AppModule } = await import('./app.module.js');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
        logger: false,
      });
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      try {
        expect((await app.inject({ method: 'GET', url: '/health/liveness' })).statusCode).toBe(200);
        // No connector in the harness: the slot and the publication are degraded, not down.
        const readiness = await app.inject({ method: 'GET', url: '/health/readiness' });
        expect(readiness.statusCode).toBe(200);
        expect(readiness.json()).toMatchObject({ data: { status: 'degraded' } });

        const missing = await app.inject({
          method: 'GET',
          url: `/v1/dates/${DATE_ID}/panes/tickets`,
        });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toMatchObject({ error: { code: ApiErrorCode.NOT_FOUND } });
      } finally {
        await app.close();
      }
    },
    CASE_MS,
  );
});

/** Records what the consumer does with Kafka, and whether the pool was open when it stopped. */
class StubKafka {
  public readonly subscribed: string[][] = [];
  public readonly handlers: ConsumerRunConfig['eachMessage'][] = [];
  public readonly sent: ProducerRecord[] = [];
  public readonly poolOpenAtStop: boolean[] = [];
  public poolOpen: () => boolean = () => false;

  public producer(): Producer {
    return {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      send: (record: ProducerRecord) => {
        this.sent.push(record);
        return Promise.resolve([]);
      },
    } as unknown as Producer;
  }

  public consumer(): Consumer {
    return {
      connect: () => Promise.resolve(),
      subscribe: ({ topics }: { topics: string[] }) => {
        this.subscribed.push(topics);
        return Promise.resolve();
      },
      run: ({ eachMessage }: ConsumerRunConfig) => {
        this.handlers.push(eachMessage);
        return Promise.resolve();
      },
      disconnect: () => {
        this.poolOpenAtStop.push(this.poolOpen());
        return Promise.resolve();
      },
    } as unknown as Consumer;
  }
}

describe('the consumer process', () => {
  it(
    'starts its consumers, retries a fact about a date not opened yet, stops before the pool closes',
    async () => {
      const { ConsumerModule, CATALOG_DATE_TOPIC } = await import('./consumer.module.js');
      const kafka = new StubKafka();
      const context = await Test.createTestingModule({ imports: [ConsumerModule] })
        .overrideProvider(Kafka)
        .useValue(kafka)
        .compile();
      await context.init();
      const pool = context.get(DataSource);
      kafka.poolOpen = () => pool.isInitialized;

      expect(kafka.subscribed).toEqual([[CATALOG_DATE_TOPIC], [retryTopic(Service.TICKETING)]]);
      const scheduled = create(DateScheduledSchema, {
        dateId: DATE_ID,
        startsAt: timestampFromDate(new Date('2026-12-12T19:00:00.000Z')),
        occurredAt: timestampFromDate(new Date('2026-09-27T10:00:00.000Z')),
      });
      await kafka.handlers[0]?.({
        topic: CATALOG_DATE_TOPIC,
        partition: 0,
        message: {
          key: Buffer.from(DATE_ID),
          value: Buffer.from(toBinary(DateScheduledSchema, scheduled)),
          headers: {
            'message-id': Buffer.from('01a0f1ee-0000-7000-8000-000000000001'),
            type: Buffer.from('catalog.date.scheduled.v1'),
          },
        },
      } as unknown as EachMessagePayload);
      expect(kafka.sent.map((record) => record.topic)).toEqual([retryTopic(Service.TICKETING)]);

      await context.close();
      expect(kafka.poolOpenAtStop).toEqual([true, true]);
      expect(pool.isInitialized).toBe(false);
    },
    CASE_MS,
  );
});

describe('the sweeper process', () => {
  it(
    'publishes a moved date on its first pass, and lets that pass commit before the pool closes',
    async () => {
      const seed = new DataSource({ type: 'postgres', url: databaseUrl });
      await seed.initialize();
      try {
        await seed.query(
          `INSERT INTO date_sales (date_id, channel_id, capacity_total, capacity_tiers,
                                   seats_available, seats_sold, waitlist_count, price_tiers,
                                   prices_locked_at, version, availability_dirty_since)
           VALUES ($1, 'channel-boot', 10, '[]', 10, 0, 0, '[]', now(), 2, now())`,
          [DATE_ID],
        );

        const { SweeperModule } = await import('./sweeper.module.js');
        const context = await Test.createTestingModule({ imports: [SweeperModule] }).compile();
        await context.init();
        const published = async (): Promise<number> => {
          const [counted] = await seed.query<{ rows: number }[]>(
            'SELECT count(*)::int AS rows FROM outbox_event WHERE aggregateid = $1',
            [DATE_ID],
          );
          return counted?.rows ?? 0;
        };
        try {
          const deadline = Date.now() + 10_000;
          while ((await published()) === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } finally {
          await context.close();
        }

        expect(await published()).toBe(1);
        const [row] = await seed.query<{ availability_dirty_since: Date | null }[]>(
          'SELECT availability_dirty_since FROM date_sales WHERE date_id = $1',
          [DATE_ID],
        );
        expect(row?.availability_dirty_since).toBeNull();
      } finally {
        await seed.destroy();
      }
    },
    CASE_MS,
  );
});
