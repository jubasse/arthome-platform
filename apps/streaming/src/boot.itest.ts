import { serveEndpoints } from '@arthome-platform/http-edge';
import { retryTopic } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  Kafka,
  type Consumer,
  type ConsumerRunConfig,
  type Producer,
  type ProducerRecord,
} from 'kafkajs';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SERVICE } from './service.js';

/**
 * Each process's root module, booted as its entry point boots it, against a real Postgres: a
 * module the root graph misses, or its `CqrsModule.forRoot()` dropped, fails here rather than at a
 * deploy. The service's modules are imported only once `DATABASE_URL` names the container, since
 * `env.ts` reads it at import. Kafka is stubbed.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

let stack: StartedStack;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'streaming_boot_itest');
  process.env.DATABASE_URL = database.url;
  const { STREAMING_SCHEMA } = await import('./itest/schema.js');
  await (await applyMigrations(database, STREAMING_SCHEMA)).destroy();
}, STARTUP_MS);

afterAll(async () => {
  await stack?.stop();
});

describe('the API process', () => {
  it(
    'boots AppModule and answers its split probes and its development docs',
    async () => {
      const { AppModule } = await import('./app.module.js');
      const { mountStreamingDocs } = await import('./streaming-docs.js');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
        logger: false,
      });
      serveEndpoints(app);
      mountStreamingDocs(app);
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      try {
        expect((await app.inject({ method: 'GET', url: '/health/liveness' })).statusCode).toBe(200);
        // No connector in the harness: the slot and the publication are degraded, not down.
        const readiness = await app.inject({ method: 'GET', url: '/health/readiness' });
        expect(readiness.statusCode).toBe(200);
        expect(readiness.json()).toMatchObject({ data: { status: 'degraded' } });
        expect((await app.inject({ method: 'GET', url: '/docs-json' })).statusCode).toBe(200);
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
  public readonly poolOpenAtStop: boolean[] = [];
  public poolOpen: () => boolean = () => false;

  public producer(): Producer {
    return {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      send: (_record: ProducerRecord) => Promise.resolve([]),
    } as unknown as Producer;
  }

  public consumer(): Consumer {
    return {
      connect: () => Promise.resolve(),
      subscribe: ({ topics }: { topics: string[] }) => {
        this.subscribed.push(topics);
        return Promise.resolve();
      },
      run: (_config: ConsumerRunConfig) => Promise.resolve(),
      disconnect: () => {
        this.poolOpenAtStop.push(this.poolOpen());
        return Promise.resolve();
      },
    } as unknown as Consumer;
  }
}

describe('the consumer process', () => {
  it(
    'subscribes its topics and its retry topic, and stops before the pool closes',
    async () => {
      const { ConsumerModule, CONSUMED_TOPICS } = await import('./consumer.module.js');
      const kafka = new StubKafka();
      const context = await Test.createTestingModule({ imports: [ConsumerModule] })
        .overrideProvider(Kafka)
        .useValue(kafka)
        .compile();
      await context.init();
      const pool = context.get(DataSource);
      kafka.poolOpen = () => pool.isInitialized;

      expect(kafka.subscribed).toEqual([[...CONSUMED_TOPICS], [retryTopic(SERVICE)]]);

      await context.close();
      expect(kafka.poolOpenAtStop).toEqual([true, true]);
      expect(pool.isInitialized).toBe(false);
    },
    CASE_MS,
  );
});

describe('the sweeper process', () => {
  it(
    'boots SweeperModule, and closes its pool once its passes have stopped',
    async () => {
      const { SweeperModule } = await import('./sweeper.module.js');
      const context = await Test.createTestingModule({ imports: [SweeperModule] }).compile();
      await context.init();
      const pool = context.get(DataSource);
      expect(pool.isInitialized).toBe(true);

      await context.close();
      expect(pool.isInitialized).toBe(false);
    },
    CASE_MS,
  );
});
