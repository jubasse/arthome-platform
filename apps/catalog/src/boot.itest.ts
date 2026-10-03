import { ChatMode, DateChatPolicyChangedSchema } from '@arthome-platform/events';
import { deadLetterTopic } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  mintInternalToken,
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

import { ApiErrorCode, Service, SystemClock } from '@arthome/core';

/**
 * The two processes' root modules, booted as `main.ts` and `consumer.ts` boot them, against a real
 * Postgres: a module the root graph misses, or its `CqrsModule.forRoot()` dropped, fails here rather
 * than at a deploy. OpenSearch and Kafka are stubbed. The service's modules are imported only once
 * `DATABASE_URL` names the container, since `env.ts` reads it at import.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

let stack: StartedStack;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'catalog_boot_itest');
  process.env.DATABASE_URL = database.url;
  const { CATALOG_SCHEMA } = await import('./itest/schema.js');
  await (await applyMigrations(database, CATALOG_SCHEMA)).destroy();
}, STARTUP_MS);

afterAll(async () => {
  await stack?.stop();
});

describe('the API process', () => {
  it(
    'boots AppModule, answers through its own global providers, and writes through its pool',
    async () => {
      const { AppModule } = await import('./app.module.js');
      const { OPENSEARCH } = await import('./search/search-catalog.handler.js');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(OPENSEARCH)
        .useValue({ close: () => Promise.resolve() })
        .compile();
      const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
        logger: false,
      });
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      try {
        expect((await app.inject({ method: 'GET', url: '/health/liveness' })).statusCode).toBe(200);
        const authorization = `Bearer ${await mintInternalToken({
          service: Service.CATALOG,
          clock: new SystemClock(),
        })}`;

        const venue = await app.inject({
          method: 'POST',
          url: '/venues',
          headers: { 'content-type': 'application/json', authorization },
          payload: { name: 'Salle', city: 'Lyon', country: 'FR', timeZone: 'Europe/Paris' },
        });
        expect(venue.statusCode).toBe(201);
        expect(venue.json()).toMatchObject({ data: { venueId: expect.any(String) as unknown } });

        const missing = await app.inject({
          method: 'GET',
          url: '/dates/01a0e700-0000-7000-8000-0000000009ff',
          headers: { authorization },
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
    'starts its consumers, dead-letters a fact about an unknown date, stops before the pool closes',
    async () => {
      const { ConsumerModule, SOURCE_TOPICS } = await import('./consumer.module.js');
      const kafka = new StubKafka();
      const context = await Test.createTestingModule({ imports: [ConsumerModule] })
        .overrideProvider(Kafka)
        .useValue(kafka)
        .compile();
      await context.init();
      const pool = context.get(DataSource);
      kafka.poolOpen = () => pool.isInitialized;

      expect(kafka.subscribed[0]).toEqual(SOURCE_TOPICS);
      const policy = create(DateChatPolicyChangedSchema, {
        dateId: '01a0e700-0000-7000-8000-0000000003ff',
        mode: ChatMode.OPEN,
        occurredAt: timestampFromDate(new Date('2026-09-26T10:00:00.000Z')),
      });
      await kafka.handlers[0]?.({
        topic: 'arthome.chat.date',
        partition: 0,
        message: {
          key: Buffer.from(policy.dateId),
          value: Buffer.from(toBinary(DateChatPolicyChangedSchema, policy)),
          headers: {
            'message-id': Buffer.from('01a0e7ee-0000-7000-8000-000000000001'),
            type: Buffer.from('chat.date_chat_policy.changed.v1'),
          },
        },
      } as unknown as EachMessagePayload);
      expect(kafka.sent.map((record) => record.topic)).toEqual([deadLetterTopic(Service.CATALOG)]);

      await context.close();
      expect(kafka.poolOpenAtStop).toEqual([true, true]);
      expect(pool.isInitialized).toBe(false);
    },
    CASE_MS,
  );
});
