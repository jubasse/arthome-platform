import {
  DateOutcome as WireDateOutcome,
  PublicationStateChangedSchema,
} from '@arthome-platform/events';
import {
  ATTEMPT_HEADER,
  DLQ_REASON_HEADER,
  deadLetterTopic,
  retryTopic,
  Outcome,
  runConsumers,
  type Disposition,
} from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  createTopics,
  startStack,
  waitForMessage,
  type StartedStack,
} from '@arthome-platform/testing';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DateOutcome, FixedClock, Service } from '@arthome/core';

import { ApplyCatalogDateFactHandler } from './apply-catalog-date-fact.handler.js';
import { applyCatalogDateMessage } from './catalog-date-messages.js';
import { DateSalesRow } from './date-sales.entity.js';
import { CLOCK } from '../clock.js';
import { CATALOG_DATE_TOPIC } from '../consumer.module.js';
import {
  catalogMessage,
  drafted,
  engaged,
  outcomeDeclared,
  rescheduled,
  scheduled,
  type CatalogMessage,
} from '../itest/catalog-messages.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * Catalog's facts through a real broker into a real Postgres, with the consumer's own retry and
 * dead-letter topics: a duplicate, an older fact arriving late, a fact about a date not opened
 * yet, and bytes no retry can read. AGENTS.md "When a message cannot be applied" is the contract.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const CHANNEL = 'channel-consumer-itest';
const NOW = '2026-09-27T10:00:00.000Z';

let stack: StartedStack;
let dataSource: DataSource;
let cqrs: TestingModule;
let kafka: Kafka;
let producer: Producer;
let stopConsumers: () => Promise<void> = () => Promise.resolve();
const dispositions: (readonly [topic: string, disposition: Disposition])[] = [];

async function send(message: CatalogMessage): Promise<void> {
  await producer.send({ topic: CATALOG_DATE_TOPIC, messages: [message] });
}

/** The disposition of the next message the consumers finish with, on whichever topic. */
async function nextDisposition(
  timeoutMs = 30_000,
): Promise<readonly [topic: string, disposition: Disposition]> {
  const seen = dispositions.length;
  const deadline = Date.now() + timeoutMs;
  while (dispositions.length === seen) {
    if (Date.now() > deadline) throw new Error(`no disposition within ${String(timeoutMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const next = dispositions[seen];
  if (next === undefined) throw new Error('no disposition');
  return next;
}

async function dispositionOf(message: CatalogMessage): Promise<Disposition> {
  const next = nextDisposition();
  await send(message);
  return (await next)[1];
}

function rowOf(dateId: string): Promise<DateSalesRow | null> {
  return dataSource.getRepository(DateSalesRow).findOneBy({ date_id: dateId });
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, kafka: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_consumer_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  cqrs = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      TicketingTransactions,
      ApplyCatalogDateFactHandler,
      { provide: DataSource, useValue: dataSource },
      { provide: CLOCK, useValue: new FixedClock(NOW) },
    ],
  }).compile();
  await cqrs.init();
  const commands = cqrs.get(CommandBus);

  kafka = new Kafka({
    clientId: 'ticketing-consumer-itest',
    brokers: [...stack.kafka.brokers],
    logLevel: logLevel.NOTHING,
  });
  await createTopics(kafka, [
    { topic: CATALOG_DATE_TOPIC, partitions: 12 },
    { topic: retryTopic(Service.TICKETING), partitions: 3 },
    { topic: deadLetterTopic(Service.TICKETING), partitions: 3 },
  ]);
  producer = kafka.producer();
  await producer.connect();
  stopConsumers = await runConsumers({
    kafka,
    producer,
    service: Service.TICKETING,
    sources: [
      {
        topic: CATALOG_DATE_TOPIC,
        handler: (payload) => applyCatalogDateMessage(commands, payload),
      },
    ],
    onDisposition: (topic, disposition) => dispositions.push([topic, disposition]),
  });
}, STARTUP_MS);

afterAll(async () => {
  await stopConsumers();
  await producer?.disconnect();
  await cqrs?.close();
  await dataSource?.destroy();
  await stack?.stop();
});

describe('the catalog date consumer', () => {
  it(
    'opens a sale once: the same message again is a duplicate, another draft is superseded',
    async () => {
      const dateId = '01a0f300-0000-7000-8000-000000000001';
      const draft = drafted(dateId, CHANNEL, NOW);

      expect(await dispositionOf(draft)).toBe(Outcome.APPLIED);
      expect(await dispositionOf(draft)).toBe(Outcome.DUPLICATE);
      expect(await dispositionOf(drafted(dateId, CHANNEL, NOW))).toBe(Outcome.SUPERSEDED);
      expect(await rowOf(dateId)).toMatchObject({ channel_id: CHANNEL, version: 1 });
    },
    CASE_MS,
  );

  it(
    'keeps the newer start and outcome when an older fact arrives after them',
    async () => {
      const dateId = '01a0f300-0000-7000-8000-000000000002';
      await dispositionOf(drafted(dateId, CHANNEL, NOW));
      const movedTo = '2026-12-19T19:00:00.000Z';

      expect(await dispositionOf(rescheduled(dateId, movedTo, '2026-09-28T10:00:00.000Z'))).toBe(
        Outcome.APPLIED,
      );
      expect(await dispositionOf(scheduled(dateId, '2026-12-12T19:00:00.000Z', NOW))).toBe(
        Outcome.SUPERSEDED,
      );
      expect(
        await dispositionOf(
          outcomeDeclared(dateId, WireDateOutcome.CANCELLED, '2026-09-29T10:00:00.000Z'),
        ),
      ).toBe(Outcome.APPLIED);
      expect(
        await dispositionOf(
          outcomeDeclared(dateId, WireDateOutcome.POSTPONED, '2026-09-28T10:00:00.000Z'),
        ),
      ).toBe(Outcome.SUPERSEDED);

      expect(await rowOf(dateId)).toMatchObject({
        starts_at: new Date(movedTo),
        outcome: DateOutcome.CANCELLED,
        sales_closed_at: new Date('2026-09-29T10:00:00.000Z'),
        on_sale: false,
      });
    },
    CASE_MS,
  );

  it(
    'opens the sale at the engagement, and closes it for good on a cancellation',
    async () => {
      const dateId = '01a0f300-0000-7000-8000-000000000003';
      await dispositionOf(drafted(dateId, CHANNEL, NOW));

      expect(await dispositionOf(engaged(dateId, '2026-09-27T11:00:00.000Z'))).toBe(
        Outcome.APPLIED,
      );
      expect(await rowOf(dateId)).toMatchObject({ on_sale: true, version: 2 });
      expect(await dispositionOf(engaged(dateId, '2026-09-27T12:00:00.000Z'))).toBe(
        Outcome.SUPERSEDED,
      );

      await dispositionOf(
        outcomeDeclared(dateId, WireDateOutcome.INTERRUPTED, '2026-09-30T20:00:00.000Z'),
      );
      expect(await rowOf(dateId)).toMatchObject({
        on_sale: false,
        outcome: DateOutcome.INTERRUPTED,
      });
    },
    CASE_MS,
  );

  it(
    'ignores what catalog says that ticketing keeps nothing of',
    async () => {
      expect(
        await dispositionOf(
          catalogMessage('catalog.publication.state_changed.v1', PublicationStateChangedSchema, {
            dateId: '01a0f300-0000-7000-8000-000000000004',
          }),
        ),
      ).toBe(Outcome.IGNORED);
    },
    CASE_MS,
  );

  it(
    'retries a fact about a date not opened yet, and applies it once its draft has been',
    async () => {
      const dateId = '01a0f300-0000-7000-8000-000000000005';
      const startsAt = '2026-12-12T19:00:00.000Z';

      expect(await dispositionOf(scheduled(dateId, startsAt, NOW))).toBe('retried');
      expect(await dispositionOf(drafted(dateId, CHANNEL, NOW))).toBe(Outcome.APPLIED);
      // RETRY_DELAYS_MS's first tier is 5 s, jittered by up to a fifth.
      expect(await nextDisposition(15_000)).toEqual([
        retryTopic(Service.TICKETING),
        Outcome.APPLIED,
      ]);
      expect(await rowOf(dateId)).toMatchObject({ starts_at: new Date(startsAt), version: 2 });
    },
    CASE_MS,
  );

  it(
    'dead-letters at once what no retry can read: no message-id, or bytes of another schema',
    async () => {
      const dateId = '01a0f300-0000-7000-8000-000000000006';
      const withoutId: CatalogMessage = {
        ...drafted(dateId, CHANNEL, NOW),
        headers: { type: 'catalog.date.drafted.v1' },
      };
      const unreadable: CatalogMessage = {
        ...drafted(dateId, CHANNEL, NOW),
        value: Buffer.from([0xff, 0xff, 0xff]),
      };

      expect(await dispositionOf(withoutId)).toBe('dead-lettered');
      expect(await dispositionOf(unreadable)).toBe('dead-lettered');

      const parked = await waitForMessage(kafka, {
        topic: deadLetterTopic(Service.TICKETING),
        matches: (message) => message.headers['message-id'] === unreadable.headers['message-id'],
      });
      expect(parked.key).toBe(dateId);
      expect(parked.headers[ATTEMPT_HEADER]).toBe('0');
      expect(parked.headers[DLQ_REASON_HEADER]).toBe('permanent');
      expect(await rowOf(dateId)).toBeNull();
    },
    CASE_MS,
  );
});
