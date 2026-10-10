import { setTimeout as delay } from 'node:timers/promises';

import { DateOutcome as WireDateOutcome } from '@arthome-platform/events';
import {
  Outcome,
  claimMessage,
  deadLetterTopic,
  retryTopic,
  runConsumers,
  type Disposition,
} from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  createTopics,
  headersOf,
  httpApp,
  registerOutboxConnector,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { CommandBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AVAILABILITY_PUBLISH_MIN_INTERVAL_SECONDS,
  DateOutcome,
  FixedClock,
  Service,
} from '@arthome/core';

import { ApiReadinessModule } from './api-readiness.js';
import { AvailabilityPublisher } from '../availability/availability-publisher.js';
import { AvailabilityPublisherModule } from '../availability/availability-publisher.module.js';
import { PublishDueAvailability } from '../availability/publish-due-availability.command.js';
import { CLOCK } from '../clock.js';
import { CATALOG_DATE_TOPIC } from '../consumer.module.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { drafted, outcomeDeclared, type CatalogMessage } from '../itest/catalog-messages.js';
import { purchaseOf, putOnSale, seatCancellationOf } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import type { PurchasedSeats } from '../orders/order-views.js';
import { OrdersModule } from '../orders/orders.module.js';
import type { PurchaseAnswer } from '../orders/purchase-seat.command.js';
import { FakePaymentProvider } from '../payments/fake-payment-provider.js';
import { PaymentWorker } from '../payments/payment-worker.js';
import { PaymentWorkerModule } from '../payments/payment-worker.module.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { SeatsModule } from '../seats/seats.module.js';

/**
 * adr-ticketing.md §12's Kafka drill, end to end on containers: ticketing's own connector, as
 *   `infra/debezium/ticketing-outbox.json` commits it, routes the outbox to its topics; Kafka is
 *   paused while purchases, a seat's cancellation and the publisher commit. The API stays ready on
 *   its database; once Kafka is back every outbox row reaches its topic in commit order per key,
 *   and the catalog consumer, never restarted, applies a cancellation produced after the outage.
 */

const STARTUP_MS = 300_000;
const CASE_MS = 600_000;
/** Longer than a Connect worker's and a consumer's session, so both rejoin their groups after it. */
const OUTAGE_MS = 30_000;
/**
 * Past its session the Connect worker may be evicted from its group as the broker resumes, and
 *   its lost connector waits `scheduled.rebalance.max.delay.ms`, five minutes by default, before
 *   it is assigned again: measured, 1.5 s, 300.9 s and 302.5 s from the resume to the last row.
 */
const DELIVERY_MS = 420_000;

const NOW = '2026-10-08T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const CHANNEL = '01a0d20c-0000-7000-8000-000000000001';
const DATE_ID = '01a0d200-0000-7000-8000-000000000001';
const LIVE_DATE_ID = '01a0d200-0000-7000-8000-000000000002';
const TICKETING_TOPICS = [
  { topic: 'arthome.ticketing.date_sales', partitions: 12 },
  { topic: 'arthome.ticketing.order', partitions: 6 },
  { topic: 'arthome.ticketing.account', partitions: 3 },
];

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let clock: FixedClock;
let kafka: Kafka;
let producer: Producer;
let observer: Consumer;
let stopConsumers: () => Promise<void> = () => Promise.resolve();
const dispositions: Disposition[] = [];

interface Delivery {
  readonly messageId: string;
  readonly key: string;
  readonly applied: boolean;
}
/** What the topics delivered, in each partition's order, as a consumer applying by message-id. */
const deliveries: Delivery[] = [];

const commands = (): CommandBus => app.get(CommandBus);

async function until(what: string, ready: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await ready())) {
    if (performance.now() > deadline) throw new Error(`${what}, not within ${timeoutMs} ms`);
    await delay(250);
  }
}

async function dispositionOf(message: CatalogMessage): Promise<Disposition> {
  const seen = dispositions.length;
  await producer.send({ topic: CATALOG_DATE_TOPIC, messages: [message] });
  await until('the catalog consumer answering', () => Promise.resolve(dispositions.length > seen));
  const disposition = dispositions[seen];
  if (disposition === undefined) throw new Error('no disposition');
  return disposition;
}

async function bought(quantity: number): Promise<PurchasedSeats> {
  const answer: PurchaseAnswer = await commands().execute(purchaseOf(DATE_ID, quantity));
  return answer.response.envelope.data as PurchasedSeats;
}

async function readinessStatus(): Promise<number> {
  return (await app.inject({ method: 'GET', url: '/health/readiness' })).statusCode;
}

async function outboxRows(): Promise<{ id: string; aggregateid: string }[]> {
  return dataSource.query('SELECT id, aggregateid FROM outbox_event ORDER BY id');
}

async function createTopicsOnceHosted(topics: Parameters<typeof createTopics>[1]): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await createTopics(kafka, topics);
      return;
    } catch (error) {
      if (attempt === 5) throw error;
      await delay(1_000);
    }
  }
}

beforeAll(async () => {
  stack = await startStack({ connect: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_kafka_down_drill');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  kafka = new Kafka({
    clientId: 'ticketing-kafka-down-drill',
    brokers: [...stack.kafka.brokers],
    logLevel: logLevel.NOTHING,
  });
  // A broker just started may answer a fresh topic's metadata before it hosts the partitions.
  await createTopicsOnceHosted([
    ...TICKETING_TOPICS,
    { topic: CATALOG_DATE_TOPIC, partitions: 12 },
    { topic: retryTopic(Service.TICKETING), partitions: 3 },
    { topic: deadLetterTopic(Service.TICKETING), partitions: 3 },
  ]);
  // On the empty outbox, before any write: every row the drill commits is in the slot's stream.
  await registerOutboxConnector(stack.connect, Service.TICKETING, database, 180_000);

  clock = new FixedClock(NOW);
  app = await httpApp({
    imports: [
      ApiReadinessModule,
      OrdersModule,
      SeatsModule,
      PaymentWorkerModule,
      AvailabilityPublisherModule,
      DateSalesModule,
      CatalogFactsModule,
    ],
    providers: EDGE_PROVIDERS,
    dataSource,
    overrides: [
      [CLOCK, clock],
      [FakePaymentProvider, new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock)],
      [PUBLIC_WEB_ORIGIN, 'http://storefront.test'],
      [PaymentWorker, {}],
      [AvailabilityPublisher, {}],
    ],
  });

  producer = kafka.producer();
  await producer.connect();
  stopConsumers = await runConsumers({
    kafka,
    producer,
    service: Service.TICKETING,
    sources: [
      {
        topic: CATALOG_DATE_TOPIC,
        handler: (payload) => applyCatalogDateMessage(commands(), payload),
      },
    ],
    onDisposition: (_topic, disposition) => dispositions.push(disposition),
  });

  observer = kafka.consumer({ groupId: 'ticketing-kafka-down-drill-observer' });
  await observer.connect();
  await observer.subscribe({
    topics: TICKETING_TOPICS.map(({ topic }) => topic),
    fromBeginning: true,
  });
  await observer.run({
    eachMessage: async (payload) => {
      const messageId = headersOf(payload)['message-id'] ?? '';
      const applied = await dataSource.transaction((manager) =>
        claimMessage(manager, messageId, payload.topic),
      );
      deliveries.push({ messageId, key: payload.message.key?.toString('utf8') ?? '', applied });
    },
  });
}, STARTUP_MS);

afterAll(async () => {
  await observer?.disconnect();
  await stopConsumers();
  await producer?.disconnect();
  await app?.close();
  await stack?.stop();
});

describe('Kafka down (adr-ticketing.md §12)', () => {
  it(
    'keeps every event in the outbox through the outage, then delivers each in order per key',
    async () => {
      await putOnSale(
        commands(),
        { dateId: DATE_ID, channelId: CHANNEL, capacity: 20, startsAt: STARTS_AT },
        NOW,
      );
      expect(await dispositionOf(drafted(LIVE_DATE_ID, CHANNEL, NOW))).toBe(Outcome.APPLIED);
      await bought(1);
      await commands().execute(new PublishDueAvailability());
      const before = await outboxRows();
      await until('the rows before the outage delivered', () =>
        Promise.resolve(before.every(({ id }) => deliveries.some((d) => d.messageId === id))),
      );

      await stack.pause('kafka');
      const outageStarted = performance.now();
      try {
        const { tickets } = await bought(3);
        await bought(2);
        await commands().execute(seatCancellationOf(tickets[0]?.seatId ?? ''));
        clock.advance(AVAILABILITY_PUBLISH_MIN_INTERVAL_SECONDS * 1_000);
        expect(await commands().execute(new PublishDueAvailability())).toBe(1);
        expect(await readinessStatus()).toBe(200);
        while (performance.now() - outageStarted < OUTAGE_MS) await delay(1_000);
        expect(await readinessStatus()).toBe(200);
      } finally {
        await stack.unpause('kafka');
      }
      const outageMs = performance.now() - outageStarted;

      const resumed = performance.now();
      const committed = await outboxRows();
      expect(committed.length).toBeGreaterThan(before.length);
      await until(
        'every outbox row on its topic',
        () =>
          Promise.resolve(committed.every(({ id }) => deliveries.some((d) => d.messageId === id))),
        DELIVERY_MS,
      ).catch(async (error: unknown) => {
        const status = await (
          await fetch(`${stack.connect.url}/connectors/ticketing-outbox/status`)
        ).text();
        const missing = committed.filter(({ id }) => !deliveries.some((d) => d.messageId === id));
        const slot: unknown = await dataSource.query<unknown[]>(
          'SELECT active, confirmed_flush_lsn FROM pg_replication_slots',
        );
        throw new Error(
          `${String(error)}; connector ${status}; ${missing.length} missing of ${committed.length}, ${deliveries.length} deliveries; slot ${JSON.stringify(slot)}`,
        );
      });
      process.stdout.write(
        `Kafka paused for ${outageMs.toFixed(0)} ms; delivered ${(performance.now() - resumed).toFixed(0)} ms after; ${String(committed.length)} rows, ` +
          `${String(deliveries.length)} deliveries\n`,
      );

      const firstDeliveries = new Map<string, string[]>();
      for (const { messageId, key } of deliveries) {
        const ids = firstDeliveries.get(key) ?? [];
        if (!ids.includes(messageId)) firstDeliveries.set(key, [...ids, messageId]);
      }
      const committedPerKey = new Map<string, string[]>();
      for (const { id, aggregateid } of committed) {
        committedPerKey.set(aggregateid, [...(committedPerKey.get(aggregateid) ?? []), id]);
      }
      expect(firstDeliveries).toEqual(committedPerKey);
      const appliedPerMessage = new Map<string, number>();
      for (const { messageId, applied } of deliveries) {
        appliedPerMessage.set(messageId, (appliedPerMessage.get(messageId) ?? 0) + Number(applied));
      }
      expect([...appliedPerMessage.values()].every((applied) => applied === 1)).toBe(true);

      const cancellation = outcomeDeclared(DATE_ID, WireDateOutcome.CANCELLED, NOW);
      expect(await dispositionOf(cancellation)).toBe(Outcome.APPLIED);
      expect(await dispositionOf(cancellation)).toBe(Outcome.DUPLICATE);
      const [sales] = await dataSource.query<{ outcome: string | null }[]>(
        'SELECT outcome FROM date_sales WHERE date_id = $1',
        [DATE_ID],
      );
      expect(sales?.outcome).toBe(DateOutcome.CANCELLED);
    },
    CASE_MS,
  );
});
