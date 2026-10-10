import { setTimeout as delay } from 'node:timers/promises';

import { DateOutcome as WireDateOutcome } from '@arthome-platform/events';
import { Outcome, attemptsAllowedBy } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  httpApp,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { BullModule } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Job, Worker } from 'bullmq';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  FixedClock,
  MINUTE_MS,
  OrderState,
  PriceTier,
  RefundReason,
  SeatHoldState,
  Service,
  intentCancelIdempotencyKey,
  seatCancelDeadline,
  type RefundRequest,
} from '@arthome/core';

import { CLOCK } from '../clock.js';
import { DateOutcomeSweeper } from '../date-outcomes/date-outcome-sweeper.js';
import { DateOutcomesModule } from '../date-outcomes/date-outcomes.module.js';
import { SettleDateOutcomes } from '../date-outcomes/settle-date-outcomes.command.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { delivered, outcomeDeclared } from '../itest/catalog-messages.js';
import { seedPaidOrders } from '../itest/paid-orders.js';
import { FULL_PRICE_MINOR, ITEST_BUYER_ACCOUNT_ID, nextKey, putOnSale } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { ExpireDueHolds } from '../orders/expire-due-holds.command.js';
import { HoldExpirySweeper } from '../orders/hold-expiry-sweeper.js';
import { HoldExpiryModule } from '../orders/hold-expiry.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import {
  FakePaymentProvider,
  FakePaymentScenario,
  intentRefOf,
} from '../payments/fake-payment-provider.js';
import { IntentCancellationProcessor } from '../payments/intent-cancellation.processor.js';
import { OwedCallRelay, ProviderCallProducer } from '../payments/owed-call-relay.js';
import { PaymentWorker } from '../payments/payment-worker.js';
import { PaymentWorkerModule } from '../payments/payment-worker.module.js';
import { REFUND_REPLAY, checkProviderCallsDead } from '../payments/provider-call-checks.js';
import {
  INTENT_CANCELLATION_RATE_LIMIT,
  PROVIDER_CALL_SCHEDULES,
  REFUND_RATE_LIMIT,
  type ProviderCallSchedules,
} from '../payments/provider-call-queues.js';
import { ProviderCallQueuesModule } from '../payments/provider-call-queues.module.js';
import { RefundProcessor } from '../payments/refund.processor.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/**
 * adr-ticketing.md §12's first drill, on a real Postgres and a Redis of the file's own: the payment
 *   provider down. A purchase answers 503 and gives its hold back; a cancelled date's refunds and
 *   the intents owed their cancellation are attempted on their schedules, under the limiters,
 *   none given up before its bound; the provider back, each call is made once. A refund the
 *   provider keeps refusing reaches its dead row, its error and `provider_calls_dead`, and §0k's
 *   replay makes it once through the queue.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 180_000;

const PREFIX = '{ticketing-provider-down-drill}';
/** Shortened, yet long enough that the outage ends before any schedule does. */
const DRILL: ProviderCallSchedules = {
  refunds: [1_000, 4_000, 8_000, 8_000],
  intentCancellations: [1_000, 4_000, 8_000],
};
const REFUND_ATTEMPTS = attemptsAllowedBy(DRILL.refunds);
const HOLD_MS = 15 * MINUTE_MS;
const NOW = '2026-10-08T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const CHANNEL = '01a0d10c-0000-7000-8000-000000000001';
const ACCOUNT = '01a0d1aa-0000-7000-8000-000000000001';
const CANCELLED_DATE = '01a0d100-0000-7000-8000-000000000001';
const CHECKOUT_DATE = '01a0d100-0000-7000-8000-000000000002';
const PURCHASE_DATE = '01a0d100-0000-7000-8000-000000000003';
const SERIES = '01a0d101';
const REFUNDS = 50;
/** Three times the cancellations' limit, so a burst past it would show in one second. */
const CANCELLATIONS = 15;

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let clock: FixedClock;
let fake: FakePaymentProvider;
let relay: OwedCallRelay;

/** Each call that reached the fake, by key, read off a wrapper of the suite's own. */
const attempts = new Map<string, number>();
const calls = { refunds: 0, cancellations: 0 };
/** When each queue's limiter counted each job it started, retries included. */
const refundStarts: number[] = [];
const cancellationStarts: number[] = [];
/** Refused as a provider refuses a request, never as an outage, while listed. */
const refusedForGood = new Set<string>();

const commands = (): CommandBus => app.get(CommandBus);

function recordCall(key: string, queue: keyof typeof calls): void {
  attempts.set(key, (attempts.get(key) ?? 0) + 1);
  calls[queue] += 1;
}

function watchProviderCalls(): void {
  const refund = fake.refund.bind(fake);
  fake.refund = (request: RefundRequest) => {
    recordCall(request.idempotencyKey, 'refunds');
    if (refusedForGood.has(request.idempotencyKey)) {
      return Promise.reject(new Error(`fake provider refuses ${request.idempotencyKey}`));
    }
    return refund(request);
  };
  const cancelIntent = fake.cancelIntent.bind(fake);
  fake.cancelIntent = (intentRef: string, idempotencyKey: string) => {
    recordCall(idempotencyKey, 'cancellations');
    return cancelIntent(intentRef, idempotencyKey);
  };
}

function watchJobStarts(worker: Worker, starts: number[]): void {
  worker.on('active', (job: Job) => {
    if (job.processedOn !== undefined) starts.push(job.processedOn);
  });
}

/**
 * `processedOn` is read off the worker's clock before BullMQ's script runs, the window off Redis's:
 *   the next window's first job was measured 1,000 to 1,003 ms after the previous one's, so a
 *   window is taken to close this much early.
 */
const WORKER_CLOCK_SLACK_MS = 20;

/**
 * BullMQ's limiter is a fixed window, opened by the first job it starts once the previous window
 *   closed; rebuilt from each start, its job's `processedOn`, the jobs each window started.
 */
function limiterWindowsOf(starts: readonly number[], durationMs: number): number[] {
  const windows: number[] = [];
  let closesAt = -Infinity;
  for (const start of [...starts].sort((a, b) => a - b)) {
    if (start >= closesAt) {
      windows.push(0);
      closesAt = start + durationMs - WORKER_CLOCK_SLACK_MS;
    }
    windows[windows.length - 1] = (windows.at(-1) ?? 0) + 1;
  }
  return windows;
}

const busiestWindowOf = (starts: readonly number[], durationMs: number): number =>
  Math.max(0, ...limiterWindowsOf(starts, durationMs));

async function until(what: string, ready: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await ready())) {
    if (performance.now() > deadline) throw new Error(`${what}, not within ${timeoutMs} ms`);
    await delay(100);
  }
}

async function awaitingOrder(dateId: string): Promise<string> {
  fake.scenarioOf = () => FakePaymentScenario.REQUIRE_ACTION;
  const answer = await purchase(dateId);
  expect(answer.statusCode).toBe(202);
  fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
  return answer.json<{ data: { orderId: string } }>().data.orderId;
}

function purchase(dateId: string, quantity = 1) {
  return app.inject({
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
}

interface RefundRow {
  readonly id: string;
  readonly order_id: string;
  readonly idempotency_key: string;
  readonly refunded_at: Date | null;
  readonly dead_at: Date | null;
}

function dateRefunds(): Promise<RefundRow[]> {
  return dataSource.query(
    `SELECT id, order_id, idempotency_key, refunded_at, dead_at FROM order_refund
      WHERE reason = $1 ORDER BY id`,
    [RefundReason.DATE_CANCELLED],
  );
}

interface CancellationRow {
  readonly id: string;
  readonly intent_cancel_owed_at: Date | null;
  readonly intent_cancel_dead_at: Date | null;
}

function owedCancellations(orderIds: readonly string[]): Promise<CancellationRow[]> {
  return dataSource.query(
    `SELECT id, intent_cancel_owed_at, intent_cancel_dead_at FROM seat_order
      WHERE id = ANY($1) ORDER BY id`,
    [orderIds],
  );
}

async function refundedEventsPerOrder(): Promise<Map<string, number>> {
  const rows = await dataSource.query<{ aggregateid: string; events: number }[]>(
    `SELECT aggregateid, count(*)::int AS events FROM outbox_event
      WHERE type = 'ticketing.order.refunded.v1' GROUP BY aggregateid`,
  );
  return new Map(rows.map(({ aggregateid, events }) => [aggregateid, events]));
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, redis: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_provider_down_drill');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock(NOW);
  fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  watchProviderCalls();
  app = await httpApp({
    imports: [
      OrdersModule,
      PaymentWorkerModule,
      HoldExpiryModule,
      DateSalesModule,
      CatalogFactsModule,
      DateOutcomesModule,
      BullModule.forRoot({ connection: { url: stack.redis.url }, prefix: PREFIX }),
      ProviderCallQueuesModule,
    ],
    providers: EDGE_PROVIDERS,
    caller: { service: Service.TICKETING, clock, accountId: ITEST_BUYER_ACCOUNT_ID },
    dataSource,
    overrides: [
      [CLOCK, clock],
      [FakePaymentProvider, fake],
      [PUBLIC_WEB_ORIGIN, 'http://storefront.test'],
      [PROVIDER_CALL_SCHEDULES, DRILL],
      [PaymentWorker, {}],
      [HoldExpirySweeper, {}],
      [OwedCallRelay, {}],
      [DateOutcomeSweeper, {}],
    ],
  });
  relay = new OwedCallRelay(dataSource, app.get(ProviderCallProducer), clock, DRILL);
  watchJobStarts(app.get(RefundProcessor).worker, refundStarts);
  watchJobStarts(app.get(IntentCancellationProcessor).worker, cancellationStarts);
}, STARTUP_MS);

afterAll(async () => {
  fake.down = false;
  await app?.close();
  await stack?.stop();
});

describe('the payment provider down (adr-ticketing.md §12)', () => {
  it(
    'delays every call owed on its schedule and under its limiter, then makes each once',
    async () => {
      // The intents owed their cancellation: checkouts left waiting on 3-D Secure, expired.
      await putOnSale(
        commands(),
        { dateId: CHECKOUT_DATE, channelId: CHANNEL, capacity: CANCELLATIONS },
        clock.now(),
      );
      const expiring: string[] = [];
      for (let n = 0; n < CANCELLATIONS; n += 1) expiring.push(await awaitingOrder(CHECKOUT_DATE));
      clock.advance(HOLD_MS);
      await commands().execute(new ExpireDueHolds());
      expect(
        (await owedCancellations(expiring)).every(
          ({ intent_cancel_owed_at }) => intent_cancel_owed_at !== null,
        ),
      ).toBe(true);

      // A cancelled date's refunds, owed by its settlement.
      await putOnSale(
        commands(),
        { dateId: CANCELLED_DATE, channelId: CHANNEL, capacity: REFUNDS, startsAt: STARTS_AT },
        clock.now(),
      );
      await seedPaidOrders(dataSource, {
        dateId: CANCELLED_DATE,
        channelId: CHANNEL,
        series: SERIES,
        quantities: Array.from({ length: REFUNDS }, () => 1),
        accountId: ACCOUNT,
        cancelDeadline: seatCancelDeadline(STARTS_AT),
        paidAt: clock.now(),
      });
      expect(
        await applyCatalogDateMessage(
          commands(),
          delivered(outcomeDeclared(CANCELLED_DATE, WireDateOutcome.CANCELLED, clock.now())),
        ),
      ).toBe(Outcome.APPLIED);
      expect(await commands().execute(new SettleDateOutcomes())).toBe(REFUNDS);
      const owed = await dateRefunds();
      expect(owed).toHaveLength(REFUNDS);
      const refused = owed[0];
      if (refused === undefined) throw new Error('no refund owed');
      refusedForGood.add(refused.idempotency_key);

      await putOnSale(
        commands(),
        { dateId: PURCHASE_DATE, channelId: CHANNEL, capacity: 4 },
        clock.now(),
      );
      const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const warnings = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      fake.down = true;
      const outageStarted = performance.now();
      try {
        const unanswered = await purchase(PURCHASE_DATE, 2);
        expect(unanswered.statusCode).toBe(503);
        const [counters] = await dataSource.query<{ seats_available: number }[]>(
          'SELECT seats_available FROM date_sales WHERE date_id = $1',
          [PURCHASE_DATE],
        );
        expect(counters?.seats_available).toBe(4);
        const holds = await dataSource.query<{ state: string }[]>(
          'SELECT state FROM seat_hold WHERE date_id = $1',
          [PURCHASE_DATE],
        );
        expect(holds).toEqual([{ state: SeatHoldState.RELEASED }]);

        expect(await relay.relayDue()).toBe(Math.max(REFUNDS, CANCELLATIONS));
        const cancellationKeys = expiring.map((orderId) => intentCancelIdempotencyKey(orderId));
        const triedTwice = (keys: readonly string[]) =>
          keys.every((key) => (attempts.get(key) ?? 0) >= 2);
        await until('every call tried again on its schedule', () =>
          Promise.resolve(
            triedTwice(owed.map(({ idempotency_key }) => idempotency_key)) &&
              triedTwice(cancellationKeys),
          ),
        );

        expect((await dateRefunds()).filter(({ dead_at }) => dead_at !== null)).toEqual([]);
        expect(
          (await owedCancellations(expiring)).filter(
            ({ intent_cancel_dead_at }) => intent_cancel_dead_at !== null,
          ),
        ).toEqual([]);
        expect(fake.refundsMade).toBe(0);
      } finally {
        fake.down = false;
      }
      const outageMs = performance.now() - outageStarted;

      let refusedErrors: unknown[][];
      try {
        await until('every refund made but the refused one, every intent cancelled', async () => {
          const refunds = await dateRefunds();
          const cancellations = await owedCancellations(expiring);
          return (
            refunds.filter(({ refunded_at }) => refunded_at !== null).length === REFUNDS - 1 &&
            cancellations.every(({ intent_cancel_owed_at }) => intent_cancel_owed_at === null)
          );
        });
        await until(
          'the refused refund given up',
          async () => (await dateRefunds()).find(({ id }) => id === refused.id)?.dead_at !== null,
        );
        refusedErrors = errors.mock.calls.filter(([message]) =>
          String(message).includes(refused.id),
        );
      } finally {
        errors.mockRestore();
        warnings.mockRestore();
      }
      const busiest = {
        refunds: busiestWindowOf(refundStarts, REFUND_RATE_LIMIT.duration),
        cancellations: busiestWindowOf(cancellationStarts, INTENT_CANCELLATION_RATE_LIMIT.duration),
      };
      process.stdout.write(
        `provider down for ${outageMs.toFixed(0)} ms; most jobs a limiter window started: ` +
          `refunds ${String(busiest.refunds)}, cancellations ${String(busiest.cancellations)}\n`,
      );

      // At the limit, never past it: the drill's bursts fill a window.
      expect(busiest).toEqual({
        refunds: REFUND_RATE_LIMIT.max,
        cancellations: INTENT_CANCELLATION_RATE_LIMIT.max,
      });
      expect(refundStarts.length).toBeGreaterThanOrEqual(calls.refunds);
      expect(cancellationStarts.length).toBeGreaterThanOrEqual(calls.cancellations);
      expect(fake.refundsMade).toBe(REFUNDS - 1);
      const events = await refundedEventsPerOrder();
      for (const { order_id, idempotency_key } of owed) {
        expect(events.get(order_id)).toBe(
          idempotency_key === refused.idempotency_key ? undefined : 1,
        );
      }
      for (const orderId of expiring) expect(fake.isCanceled(intentRefOf(orderId))).toBe(true);

      expect(attempts.get(refused.idempotency_key)).toBe(REFUND_ATTEMPTS);
      expect(refusedErrors).toEqual([
        [expect.stringContaining('money is held without a seat'), expect.anything()],
      ]);
      expect(await checkProviderCallsDead(dataSource)).toMatchObject({
        name: 'provider_calls_dead',
        status: 'degraded',
        detail: { refunds: 1, intentCancellations: 0 },
      });

      refusedForGood.delete(refused.idempotency_key);
      await dataSource.query(REFUND_REPLAY, [refused.id]);
      expect(await relay.relayDue()).toBe(1);
      await until(
        'the replayed refund made',
        async () => (await dateRefunds()).find(({ id }) => id === refused.id)?.refunded_at !== null,
      );

      expect(attempts.get(refused.idempotency_key)).toBe(REFUND_ATTEMPTS + 1);
      expect(fake.refundsMade).toBe(REFUNDS);
      expect((await refundedEventsPerOrder()).get(refused.order_id)).toBe(1);
      expect((await checkProviderCallsDead(dataSource)).status).toBe('up');
      const states = await dataSource.query<{ state: string; orders: number }[]>(
        `SELECT state, count(*)::int AS orders FROM seat_order WHERE date_id = $1 GROUP BY state`,
        [CANCELLED_DATE],
      );
      expect(states).toEqual([{ state: OrderState.REFUNDED, orders: REFUNDS }]);
    },
    CASE_MS,
  );
});
