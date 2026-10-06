import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { OrderRefundedSchema, RefundReason as WireRefundReason } from '@arthome-platform/events';
import { OutboxEvent } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  httpApp,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Worker, type Job, type Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FixedClock,
  MINUTE_MS,
  OrderState,
  PaymentEventKind,
  PriceTier,
  RefundReason,
  SeatHoldOrigin,
  SeatHoldState,
  Service,
  money,
} from '@arthome/core';

import { ApplyPaymentEvents } from './apply-payment-events.command.js';
import {
  FakePaymentProvider,
  FakePaymentScenario,
  intentRefOf,
  type SignedWebhook,
} from './fake-payment-provider.js';
import { IntentCancellationProcessor } from './intent-cancellation.processor.js';
import { OwedCallRelay, ProviderCallProducer } from './owed-call-relay.js';
import { PaymentWebhooksModule } from './payment-webhooks.module.js';
import { PaymentWorker } from './payment-worker.js';
import { PaymentWorkerModule } from './payment-worker.module.js';
import {
  REFUND_REPLAY,
  checkProviderCallQueues,
  checkProviderCallsDead,
} from './provider-call-checks.js';
import {
  INTENT_CANCELLATION_QUEUE,
  PRODUCER_TIMEOUT_MS,
  PROVIDER_CALL_SCHEDULES,
  REFUND_QUEUE,
  intentCancelKeyOf,
  jobIdOf,
  staleAfterMs,
  type ProviderCallSchedules,
  type RefundJob,
} from './provider-call-queues.js';
import { ProviderCallQueuesModule } from './provider-call-queues.module.js';
import { refundKeyOf } from './refund-ledger.js';
import { RefundProcessor } from './refund.processor.js';
import { CLOCK } from '../clock.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import {
  FULL_PRICE_MINOR,
  ITEST_BUYER_ACCOUNT_ID,
  nextKey,
  purchaseOf,
  putOnSale,
} from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { ExpireDueHolds } from '../orders/expire-due-holds.command.js';
import { HoldExpirySweeper } from '../orders/hold-expiry-sweeper.js';
import { HoldExpiryModule } from '../orders/hold-expiry.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/**
 * The provider calls on BullMQ (HANDOVER §0m), against a real Postgres and a Redis of the file's
 *   own, which a case pauses: the relay, both processors, the limiter, the schedules shortened, a
 *   job stalled, lost or given up on. The relay's loop is stubbed, so each pass is the suite's; the
 *   workers run as the worker process runs them.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;
const DRAIN_MS = 150_000;
const STALLED_MS = 70_000;

const PREFIX = '{ticketing-provider-call-queues-itest}';
const SHORT: ProviderCallSchedules = { refunds: [100, 200], intentCancellations: [100] };
const HOLD_MS = 15 * MINUTE_MS;
const CHANNEL = '01a0fa0c-0000-7000-8000-000000000001';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let clock: FixedClock;
let fake: FakePaymentProvider;
let relay: OwedCallRelay;
let dates = 0;
let batches = 0;

const commands = (): CommandBus => app.get(CommandBus);
const refundQueue = (): Queue => app.get<Queue>(getQueueToken(REFUND_QUEUE));
const cancellationQueue = (): Queue => app.get<Queue>(getQueueToken(INTENT_CANCELLATION_QUEUE));
const relayOf = (): OwedCallRelay =>
  new OwedCallRelay(dataSource, app.get(ProviderCallProducer), clock, SHORT);

async function until(what: string, ready: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await ready())) {
    if (performance.now() > deadline) throw new Error(`${what}, not within ${timeoutMs} ms`);
    await delay(50);
  }
}

async function dateOnSale(capacity: number): Promise<string> {
  dates += 1;
  const dateId = `01a0fa00-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await putOnSale(commands(), { dateId, channelId: CHANNEL, capacity }, clock.now());
  return dateId;
}

async function awaitingOrder(dateId: string, quantity = 2): Promise<string> {
  fake.scenarioOf = () => FakePaymentScenario.REQUIRE_ACTION;
  const answer = await app.inject({
    method: 'POST',
    url: '/v1/orders/seats',
    headers: { 'content-type': 'application/json', 'idempotency-key': nextKey() },
    payload: {
      dateId,
      tier: PriceTier.FULL,
      quantity,
      expectedTotal: { amountMinor: FULL_PRICE_MINOR * quantity, currencyCode: 'EUR' },
    },
  });
  expect(answer.statusCode).toBe(202);
  fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
  return answer.json<{ data: { orderId: string } }>().data.orderId;
}

function deliver({ body, signature }: SignedWebhook) {
  return app.inject({
    method: 'POST',
    url: '/v1/payments/webhook',
    headers: {
      'content-type': 'application/json',
      [fake.signatureHeader]: signature,
      traceparent: TRACEPARENT,
    },
    payload: body,
  });
}

async function applyEvents(): Promise<void> {
  await commands().execute(new ApplyPaymentEvents(100));
}

async function expireDueHolds(): Promise<void> {
  clock.advance(HOLD_MS);
  await commands().execute(new ExpireDueHolds());
}

interface OwedRefundRow {
  readonly orderId: string;
  readonly refundId: string;
  readonly key: string;
}

/** Paid orders, each owing one refund of its whole total, their intents known to the fake. */
async function paidOrdersOwingRefunds(count: number): Promise<OwedRefundRow[]> {
  batches += 1;
  const dateId = await dateOnSale(1);
  const holdId = randomUUID();
  const now = new Date(clock.nowMs());
  await dataSource.query(
    `INSERT INTO seat_hold (id, date_id, tier, quantity, origin, origin_ref, expires_at, state,
                            version)
     VALUES ($1, $2, $3, 1, $4, $1, $5, $6, 2)`,
    [holdId, dateId, PriceTier.FULL, SeatHoldOrigin.CHECKOUT, now, SeatHoldState.CONSUMED],
  );
  const owed = Array.from({ length: count }, (): OwedRefundRow => {
    const refundId = randomUUID();
    return { orderId: randomUUID(), refundId, key: `refund:${refundId}` };
  });
  for (const { orderId } of owed) {
    await fake.createIntent({
      orderId,
      amount: money(FULL_PRICE_MINOR, 'EUR'),
      expiresAt: clock.now(),
      returnUrl: 'http://storefront.test/orders/queued',
    });
  }
  await dataSource.query(
    `INSERT INTO seat_order (id, reference, idempotency_key, fingerprint, date_id, channel_id,
                             tier, quantity, currency_code, unit_price_minor, tier_total_minor,
                             service_fee_minor, discount_minor, total_minor, hold_id, expires_at,
                             state, placed_at, paid_at, version, payment_intent_ref)
     SELECT placed.id, 'ATH-Q' || $2 || '-' || placed.n, gen_random_uuid(), 'queued', $3, $4, $5,
            1, 'EUR', $6, $6, 0, 0, $6, $7, $8, $9, $8, $8, 2,
            'pi_fake_' || replace(placed.id::text, '-', '')
       FROM unnest($1::uuid[]) WITH ORDINALITY AS placed(id, n)`,
    [
      owed.map(({ orderId }) => orderId),
      String(batches),
      dateId,
      CHANNEL,
      PriceTier.FULL,
      FULL_PRICE_MINOR,
      holdId,
      now,
      OrderState.PAID,
    ],
  );
  await dataSource.query(
    `INSERT INTO order_refund (id, order_id, amount_minor, currency_code, reason,
                               idempotency_key, owed_at)
     SELECT owed.refund_id, owed.order_id, $4, 'EUR', $5, owed.key, $6
       FROM unnest($1::uuid[], $2::uuid[], $3::text[]) AS owed(refund_id, order_id, key)`,
    [
      owed.map(({ refundId }) => refundId),
      owed.map(({ orderId }) => orderId),
      owed.map(({ key }) => key),
      FULL_PRICE_MINOR,
      RefundReason.GOODWILL,
      now,
    ],
  );
  return owed;
}

async function refundOf(refundId: string) {
  const [row] = await dataSource.query<
    {
      enqueued_at: Date | null;
      refunded_at: Date | null;
      dead_at: Date | null;
      refund_ref: string | null;
    }[]
  >('SELECT enqueued_at, refunded_at, dead_at, refund_ref FROM order_refund WHERE id = $1', [
    refundId,
  ]);
  if (row === undefined) throw new Error(`no refund ${refundId}`);
  return row;
}

async function madeCount(refundIds: readonly string[]): Promise<number> {
  const [made] = await dataSource.query<{ made: number }[]>(
    'SELECT count(*)::int AS made FROM order_refund WHERE id = ANY($1) AND refunded_at IS NOT NULL',
    [refundIds],
  );
  return made?.made ?? 0;
}

async function cancellationOf(orderId: string) {
  const [row] = await dataSource.query<
    {
      intent_cancel_owed_at: Date | null;
      intent_cancel_enqueued_at: Date | null;
      intent_cancel_dead_at: Date | null;
    }[]
  >(
    `SELECT intent_cancel_owed_at, intent_cancel_enqueued_at, intent_cancel_dead_at
       FROM seat_order WHERE id = $1`,
    [orderId],
  );
  if (row === undefined) throw new Error(`no order ${orderId}`);
  return row;
}

const callsTo = (call: string): number => fake.calls.filter((made) => made === call).length;

const refundedEventsOf = (orderId: string): Promise<OutboxEvent[]> =>
  dataSource
    .getRepository(OutboxEvent)
    .findBy({ aggregateid: orderId, type: 'ticketing.order.refunded.v1' });

const jobGone = (queue: Queue, jobId: string) => async () =>
  (await queue.getJob(jobId)) === undefined;

beforeAll(async () => {
  stack = await startStack({ postgres: true, redis: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_provider_call_queues_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock('2026-10-06T10:00:00.000Z');
  fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  app = await httpApp({
    imports: [
      OrdersModule,
      PaymentWebhooksModule,
      PaymentWorkerModule,
      HoldExpiryModule,
      DateSalesModule,
      CatalogFactsModule,
      BullModule.forRoot({ connection: { url: stack.redis.url }, prefix: PREFIX }),
      ProviderCallQueuesModule,
    ],
    providers: EDGE_PROVIDERS,
    caller: { service: Service.TICKETING, clock, accountId: ITEST_BUYER_ACCOUNT_ID },
    dataSource,
    rawBody: true,
    overrides: [
      [CLOCK, clock],
      [FakePaymentProvider, fake],
      [PUBLIC_WEB_ORIGIN, 'http://storefront.test'],
      [PROVIDER_CALL_SCHEDULES, SHORT],
      [PaymentWorker, {}],
      [HoldExpirySweeper, {}],
      [OwedCallRelay, {}],
    ],
  });
  relay = relayOf();
}, STARTUP_MS);

beforeEach(() => {
  fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
  fake.down = false;
});

afterAll(async () => {
  await app?.close();
  await stack?.stop();
});

describe('a refund owed by a payment that found no seat (D-082)', () => {
  it(
    'is made once by the queue, its order.refunded under the webhook trace',
    async () => {
      const dateId = await dateOnSale(2);
      const orderId = await awaitingOrder(dateId);
      await expireDueHolds();
      await commands().execute(purchaseOf(dateId, 2));
      await deliver(fake.completeAction(intentRefOf(orderId)));
      await applyEvents();
      const [owed] = await dataSource.query<{ id: string }[]>(
        'SELECT id FROM order_refund WHERE order_id = $1',
        [orderId],
      );
      const refundId = owed?.id ?? '';
      const madeBefore = fake.refundsMade;

      await relay.relayDue();
      await until('the refund made', async () => (await refundOf(refundId)).refunded_at !== null);
      await relay.relayDue();

      expect((await refundOf(refundId)).enqueued_at).toEqual(new Date(clock.nowMs()));
      expect(callsTo(`refund ${refundKeyOf(orderId)}`)).toBe(1);
      expect(fake.refundsMade).toBe(madeBefore + 1);
      const [state] = await dataSource.query<{ state: string }[]>(
        'SELECT state FROM seat_order WHERE id = $1',
        [orderId],
      );
      expect(state?.state).toBe(OrderState.REFUNDED);
      const events = await refundedEventsOf(orderId);
      expect(events).toHaveLength(1);
      expect(events[0]?.tracecontext).toBe(TRACEPARENT);
      expect(fromBinary(OrderRefundedSchema, events[0]?.payload ?? new Uint8Array())).toMatchObject(
        {
          orderId,
          amount: { amountMinor: BigInt(FULL_PRICE_MINOR * 2), currencyCode: 'EUR' },
          refundReason: WireRefundReason.HOLD_EXPIRED_CAPACITY_LOST,
        },
      );
    },
    CASE_MS,
  );
});

describe('a refund the provider keeps refusing', () => {
  it(
    'is given up on its shortened schedule with the error, then replayed and made once, same key',
    async () => {
      const [owed] = await paidOrdersOwingRefunds(1);
      if (owed === undefined) throw new Error('no refund owed');
      const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      fake.down = true;
      try {
        await relay.relayDue();
        await until(
          'the refund given up',
          async () => (await refundOf(owed.refundId)).dead_at !== null,
        );
        await until('its failed job removed', jobGone(refundQueue(), jobIdOf(owed.key)));
        expect(
          errors.mock.calls.filter(([message]) => String(message).includes(owed.refundId)),
        ).toEqual([[expect.stringContaining('money is held without a seat'), expect.anything()]]);
      } finally {
        fake.down = false;
        errors.mockRestore();
      }
      expect(callsTo(`refund ${owed.key}`)).toBe(SHORT.refunds.length + 1);
      await relay.relayDue();
      expect((await refundOf(owed.refundId)).refunded_at).toBeNull();
      const dead = await checkProviderCallsDead(dataSource);
      expect(dead).toMatchObject({
        name: 'provider_calls_dead',
        status: 'degraded',
        detail: { refundReplay: REFUND_REPLAY },
      });

      const madeBefore = fake.refundsMade;
      await dataSource.query(REFUND_REPLAY, [owed.refundId]);
      await relay.relayDue();
      await until(
        'the refund replayed',
        async () => (await refundOf(owed.refundId)).refunded_at !== null,
      );

      expect(callsTo(`refund ${owed.key}`)).toBe(SHORT.refunds.length + 2);
      expect(fake.refundsMade).toBe(madeBefore + 1);
      expect(await refundedEventsOf(owed.orderId)).toHaveLength(1);
      expect((await checkProviderCallsDead(dataSource)).detail.refunds).toBe(
        Number(dead.detail.refunds) - 1,
      );
    },
    CASE_MS,
  );
});

describe('the limiter', () => {
  it(
    'makes 60 refunds at 20 a second: two seconds at least',
    async () => {
      const owed = await paidOrdersOwingRefunds(60);
      const ids = owed.map(({ refundId }) => refundId);
      const started = performance.now();

      await relay.relayDue();
      await until('the 60 refunds made', async () => (await madeCount(ids)) === 60, 30_000);

      expect(performance.now() - started).toBeGreaterThanOrEqual(2_000);
    },
    CASE_MS,
  );
});

describe('Redis down', () => {
  it(
    'lets a purchase, a webhook and an expiry commit, fails the relay within its timeout, then drains each call once',
    async () => {
      const dateId = await dateOnSale(2);
      const unseated = await awaitingOrder(dateId);
      await expireDueHolds();
      const expiring = await awaitingOrder(await dateOnSale(2));

      await stack.pause('redis');
      try {
        const purchase = await app.inject({
          method: 'POST',
          url: '/v1/orders/seats',
          headers: { 'content-type': 'application/json', 'idempotency-key': nextKey() },
          payload: {
            dateId,
            tier: PriceTier.FULL,
            quantity: 2,
            expectedTotal: { amountMinor: FULL_PRICE_MINOR * 2, currencyCode: 'EUR' },
          },
        });
        expect(purchase.statusCode).toBe(201);
        await deliver(fake.completeAction(intentRefOf(unseated)));
        await applyEvents();
        await expireDueHolds();
        expect((await cancellationOf(expiring)).intent_cancel_owed_at).not.toBeNull();

        const started = performance.now();
        await expect(relay.relayDue()).rejects.toThrow();
        expect(performance.now() - started).toBeLessThan(PRODUCER_TIMEOUT_MS * 2);
        expect(await checkProviderCallQueues(stack.redis.url)).toMatchObject({
          name: 'provider_call_queues',
          status: 'degraded',
        });

        const [owed] = await dataSource.query<{ id: string; enqueued_at: Date | null }[]>(
          'SELECT id, enqueued_at FROM order_refund WHERE order_id = $1',
          [unseated],
        );
        expect(owed?.enqueued_at).toBeNull();
        expect((await cancellationOf(expiring)).intent_cancel_enqueued_at).toBeNull();
        await dataSource.transaction(async (manager) => {
          await manager.query('SELECT id FROM order_refund WHERE order_id = $1 FOR UPDATE NOWAIT', [
            unseated,
          ]);
          await manager.query('SELECT id FROM seat_order WHERE id = $1 FOR UPDATE NOWAIT', [
            expiring,
          ]);
        });
      } finally {
        await stack.unpause('redis');
      }

      await until('the refund and the cancellation made', async () => {
        await relay.relayDue().catch(() => 0);
        const [made] = await dataSource.query<{ refunded_at: Date | null }[]>(
          'SELECT refunded_at FROM order_refund WHERE order_id = $1',
          [unseated],
        );
        return (
          made?.refunded_at != null &&
          (await cancellationOf(expiring)).intent_cancel_owed_at === null
        );
      });
      expect(callsTo(`refund ${refundKeyOf(unseated)}`)).toBe(1);
      expect(callsTo(`cancelIntent ${intentCancelKeyOf(expiring)}`)).toBe(1);
      expect(await refundedEventsOf(unseated)).toHaveLength(1);
      expect(await checkProviderCallQueues(stack.redis.url)).toMatchObject({
        status: 'up',
        detail: { [`${REFUND_QUEUE}.waiting`]: 0, [`${INTENT_CANCELLATION_QUEUE}.delayed`]: 0 },
      });
    },
    CASE_MS,
  );
});

describe('a worker killed mid-job', () => {
  it(
    'leaves its job stalled, run again by another under the same key: one refund at the fake',
    async () => {
      const [owed] = await paidOrdersOwingRefunds(1);
      if (owed === undefined) throw new Error('no refund owed');
      const processor = app.get(RefundProcessor);
      const connection = { url: stack.redis.url };
      await processor.worker.pause();
      const refund = fake.refund.bind(fake);
      let reachedProvider: () => void = () => undefined;
      const atProvider = new Promise<void>((resolve) => {
        reachedProvider = resolve;
      });
      fake.refund = async (request) => {
        await refund(request);
        reachedProvider();
        return new Promise<never>(() => undefined);
      };
      const doomed = new Worker<RefundJob>(
        REFUND_QUEUE,
        (job: Job<RefundJob>) => processor.process(job),
        { connection, prefix: PREFIX, lockDuration: 1_000 },
      );
      const checker = new Worker(REFUND_QUEUE, null, {
        connection,
        prefix: PREFIX,
        autorun: false,
        stalledInterval: 500,
      });
      const madeBefore = fake.refundsMade;
      const jobId = jobIdOf(owed.key);
      try {
        await relay.relayDue();
        await atProvider;
        await doomed.close(true);
        fake.refund = refund;
        // A check runs at most once per interval across workers, the app's every 30 s: the
        //   job is back in wait within about that once its 1 s lock lapsed.
        void checker.startStalledCheckTimer();
        await until(
          'the stalled job back in wait',
          async () => (await refundQueue().getJobState(jobId)) === 'waiting',
          STALLED_MS,
        );
        await processor.worker.resume();

        await until(
          'the stalled refund made',
          async () => (await refundOf(owed.refundId)).refunded_at !== null,
        );
      } finally {
        fake.refund = refund;
        await processor.worker.resume();
        await checker.close();
        await doomed.close(true);
      }

      expect(callsTo(`refund ${owed.key}`)).toBe(2);
      expect(fake.refundsMade).toBe(madeBefore + 1);
      expect(await refundedEventsOf(owed.orderId)).toHaveLength(1);
    },
    STALLED_MS + CASE_MS,
  );
});

describe("an intent's cancellation", () => {
  it(
    'cleared by a payment before its job runs: the job ends, no call',
    async () => {
      const orderId = await awaitingOrder(await dateOnSale(4));
      await expireDueHolds();
      const processor = app.get(IntentCancellationProcessor);
      const jobId = jobIdOf(intentCancelKeyOf(orderId));
      await processor.worker.pause();
      try {
        await relay.relayDue();
        expect(await cancellationQueue().getJob(jobId)).toBeDefined();
        await deliver(fake.completeAction(intentRefOf(orderId)));
        await applyEvents();
        expect((await cancellationOf(orderId)).intent_cancel_owed_at).toBeNull();
      } finally {
        await processor.worker.resume();
      }

      await until('its job settled', jobGone(cancellationQueue(), jobId));
      expect(callsTo(`cancelIntent ${intentCancelKeyOf(orderId)}`)).toBe(0);
    },
    CASE_MS,
  );

  it(
    'owed again once given up on: a new job, its attempts anew',
    async () => {
      const orderId = await awaitingOrder(await dateOnSale(2));
      await expireDueHolds();
      const owedAt = (await cancellationOf(orderId)).intent_cancel_owed_at;
      const jobId = jobIdOf(intentCancelKeyOf(orderId));
      const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      fake.down = true;
      try {
        await relay.relayDue();
        await until(
          'the cancellation given up',
          async () => (await cancellationOf(orderId)).intent_cancel_dead_at !== null,
        );
        await until('its failed job removed', jobGone(cancellationQueue(), jobId));
      } finally {
        fake.down = false;
        errors.mockRestore();
      }
      const call = `cancelIntent ${intentCancelKeyOf(orderId)}`;
      expect(callsTo(call)).toBe(SHORT.intentCancellations.length + 1);

      clock.advance(MINUTE_MS);
      await deliver(fake.webhookOf(intentRefOf(orderId), PaymentEventKind.INTENT_REQUIRES_ACTION));
      await applyEvents();
      expect(await cancellationOf(orderId)).toEqual({
        intent_cancel_owed_at: owedAt,
        intent_cancel_enqueued_at: null,
        intent_cancel_dead_at: null,
      });

      await relay.relayDue();
      await until(
        'the cancellation made',
        async () => (await cancellationOf(orderId)).intent_cancel_owed_at === null,
      );
      expect(callsTo(call)).toBe(SHORT.intentCancellations.length + 2);
      expect(fake.isCanceled(intentRefOf(orderId))).toBe(true);
    },
    CASE_MS,
  );
});

describe('a job lost by Redis', () => {
  it(
    'is enqueued again once its row is past the stale window, and made once',
    async () => {
      const [owed] = await paidOrdersOwingRefunds(1);
      if (owed === undefined) throw new Error('no refund owed');
      const processor = app.get(RefundProcessor);
      const jobId = jobIdOf(owed.key);
      await processor.worker.pause();
      const redis = new Redis(stack.redis.url);
      try {
        await relay.relayDue();
        const enqueuedAt = (await refundOf(owed.refundId)).enqueued_at;
        expect(await refundQueue().getJob(jobId)).toBeDefined();

        await redis.flushdb();
        await relay.relayDue();
        expect(await refundQueue().getJob(jobId)).toBeUndefined();
        expect((await refundOf(owed.refundId)).enqueued_at).toEqual(enqueuedAt);

        clock.advance(staleAfterMs(SHORT.refunds) + 1);
        await relay.relayDue();
        expect(await refundQueue().getJob(jobId)).toBeDefined();
        expect((await refundOf(owed.refundId)).enqueued_at).toEqual(new Date(clock.nowMs()));
      } finally {
        await processor.worker.resume();
        redis.disconnect();
      }

      await until(
        'the refund made',
        async () => (await refundOf(owed.refundId)).refunded_at !== null,
      );
      expect(callsTo(`refund ${owed.key}`)).toBe(1);
    },
    CASE_MS,
  );
});

describe('two relays racing', () => {
  it(
    'over 1,000 owed refunds enqueue each job once, and each refund is made once',
    async () => {
      const owed = await paidOrdersOwingRefunds(1_000);
      const ids = owed.map(({ refundId }) => refundId);
      const processor = app.get(RefundProcessor);
      const completed = new Map<string, number>();
      const count = (job: Job) => {
        completed.set(job.id ?? '', (completed.get(job.id ?? '') ?? 0) + 1);
      };
      processor.worker.on('completed', count);
      await processor.worker.pause();
      try {
        const drain = async (racing: OwedCallRelay) => {
          while ((await racing.relayDue()) > 0) {
            // Each pass claims rows the other skips.
          }
        };
        await Promise.all([drain(relay), drain(relayOf())]);
        expect(await refundQueue().getJobCountByTypes('waiting', 'prioritized', 'delayed')).toBe(
          1_000,
        );

        // As if both relays' commits were lost after their adds: enqueued again, ignored by id.
        await dataSource.query('UPDATE order_refund SET enqueued_at = NULL WHERE id = ANY($1)', [
          ids,
        ]);
        await Promise.all([drain(relay), drain(relayOf())]);
        expect(await refundQueue().getJobCountByTypes('waiting', 'prioritized', 'delayed')).toBe(
          1_000,
        );
      } finally {
        await processor.worker.resume();
      }

      await until('the 1,000 refunds made', async () => (await madeCount(ids)) === 1_000, DRAIN_MS);
      processor.worker.off('completed', count);

      for (const { key } of owed) {
        expect.soft(completed.get(jobIdOf(key))).toBe(1);
        expect.soft(callsTo(`refund ${key}`)).toBe(1);
      }
    },
    DRAIN_MS + CASE_MS,
  );
});
