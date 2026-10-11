import { setTimeout as delay } from 'node:timers/promises';

import { DateOutcome as WireDateOutcome } from '@arthome-platform/events';
import { Outcome } from '@arthome-platform/messaging';
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
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  FixedClock,
  MINUTE_MS,
  OrderState,
  PriceTier,
  RefundReason,
  Service,
  intentCancelIdempotencyKey,
  seatCancelDeadline,
} from '@arthome/core';

import { ApiReadinessModule } from './api-readiness.js';
import { AvailabilityPublisher } from '../availability/availability-publisher.js';
import { AvailabilityPublisherModule } from '../availability/availability-publisher.module.js';
import { PublishDueAvailability } from '../availability/publish-due-availability.command.js';
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
import { FakePaymentProvider, FakePaymentScenario } from '../payments/fake-payment-provider.js';
import { OwedCallRelay, ProviderCallProducer } from '../payments/owed-call-relay.js';
import { PaymentWorker } from '../payments/payment-worker.js';
import { PaymentWorkerModule } from '../payments/payment-worker.module.js';
import {
  checkProviderCallQueues,
  checkProviderCallsDead,
  checkProviderCallsWaiting,
} from '../payments/provider-call-checks.js';
import {
  PROVIDER_CALL_SCHEDULES,
  type ProviderCallSchedules,
} from '../payments/provider-call-queues.js';
import { ProviderCallQueuesModule } from '../payments/provider-call-queues.module.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/**
 * adr-ticketing.md §12's Redis drill, on a real Postgres and a Redis of the file's own, paused:
 *   the API holds no Redis, so it sells and stays ready; the sweeper's passes run on Postgres; a
 *   date cancelled meanwhile owes its refunds as rows, which the worker's relay cannot enqueue and
 *   leaves unstamped. Redis back, the same worker drains each call once, without a restart.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 180_000;
/** Longer than the relay's 2 s fail-fast timeout many times over, and than a blocking poll. */
const OUTAGE_MS = 20_000;

const PREFIX = '{ticketing-redis-down-drill}';
const SHORT: ProviderCallSchedules = { refunds: [100, 200], intentCancellations: [100] };
const HOLD_MS = 15 * MINUTE_MS;
const NOW = '2026-10-08T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const CHANNEL = '01a0d30c-0000-7000-8000-000000000001';
const ACCOUNT = '01a0d3aa-0000-7000-8000-000000000001';
const SELLING_DATE = '01a0d300-0000-7000-8000-000000000001';
const CANCELLED_DATE = '01a0d300-0000-7000-8000-000000000002';
const SERIES = '01a0d301';
const REFUNDS = 30;

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let clock: FixedClock;
let fake: FakePaymentProvider;
let relay: OwedCallRelay;

const commands = (): CommandBus => app.get(CommandBus);

async function until(what: string, ready: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await ready())) {
    if (performance.now() > deadline) throw new Error(`${what}, not within ${timeoutMs} ms`);
    await delay(100);
  }
}

function purchase(dateId: string, quantity: number) {
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

async function readiness() {
  const answer = await app.inject({ method: 'GET', url: '/health/readiness' });
  return { statusCode: answer.statusCode, body: answer.json<{ data: { status: string } }>() };
}

function dateRefunds(): Promise<
  {
    id: string;
    order_id: string;
    idempotency_key: string;
    enqueued_at: Date | null;
    refunded_at: Date | null;
  }[]
> {
  return dataSource.query(
    `SELECT id, order_id, idempotency_key, enqueued_at, refunded_at FROM order_refund
      WHERE reason = $1 ORDER BY id`,
    [RefundReason.DATE_CANCELLED],
  );
}

async function cancellationOf(orderId: string) {
  const [row] = await dataSource.query<
    { intent_cancel_owed_at: Date | null; intent_cancel_enqueued_at: Date | null }[]
  >('SELECT intent_cancel_owed_at, intent_cancel_enqueued_at FROM seat_order WHERE id = $1', [
    orderId,
  ]);
  if (row === undefined) throw new Error(`no order ${orderId}`);
  return row;
}

async function opsCheck() {
  return {
    queues: (await checkProviderCallQueues(stack.redis.url)).status,
    dead: (await checkProviderCallsDead(dataSource)).status,
    waiting: (await checkProviderCallsWaiting(dataSource, clock)).status,
  };
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, redis: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_redis_down_drill');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock(NOW);
  fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  app = await httpApp({
    imports: [
      ApiReadinessModule,
      OrdersModule,
      PaymentWorkerModule,
      HoldExpiryModule,
      AvailabilityPublisherModule,
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
      [PROVIDER_CALL_SCHEDULES, SHORT],
      [PaymentWorker, {}],
      [HoldExpirySweeper, {}],
      [AvailabilityPublisher, {}],
      [OwedCallRelay, {}],
      [DateOutcomeSweeper, {}],
    ],
  });
  relay = new OwedCallRelay(dataSource, app.get(ProviderCallProducer), clock, SHORT);
}, STARTUP_MS);

afterAll(async () => {
  await app?.close();
  await stack?.stop();
});

describe('Redis down (adr-ticketing.md §12)', () => {
  it(
    'sells, sweeps and owes refunds on Postgres alone, then drains each call once Redis is back',
    async () => {
      await putOnSale(
        commands(),
        { dateId: SELLING_DATE, channelId: CHANNEL, capacity: 10 },
        clock.now(),
      );
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
      fake.scenarioOf = () => FakePaymentScenario.REQUIRE_ACTION;
      const waiting = await purchase(SELLING_DATE, 2);
      fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
      expect(waiting.statusCode).toBe(202);
      const expiring = waiting.json<{ data: { orderId: string } }>().data.orderId;
      await commands().execute(new PublishDueAvailability());
      expect(await opsCheck()).toEqual({ queues: 'up', dead: 'up', waiting: 'up' });

      const warnings = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await stack.pause('redis');
      const outageStarted = performance.now();
      try {
        expect((await purchase(SELLING_DATE, 1)).statusCode).toBe(201);
        expect((await readiness()).statusCode).toBe(200);

        clock.advance(HOLD_MS);
        expect(await commands().execute(new ExpireDueHolds())).toBe(1);
        expect((await cancellationOf(expiring)).intent_cancel_owed_at).not.toBeNull();
        expect(await commands().execute(new PublishDueAvailability())).toBe(1);
        expect(
          await applyCatalogDateMessage(
            commands(),
            delivered(outcomeDeclared(CANCELLED_DATE, WireDateOutcome.CANCELLED, clock.now())),
          ),
        ).toBe(Outcome.APPLIED);
        expect(await commands().execute(new SettleDateOutcomes())).toBe(REFUNDS);
        expect(await dateRefunds()).toHaveLength(REFUNDS);

        await expect(relay.relayDue()).rejects.toThrow();
        expect((await dateRefunds()).filter(({ enqueued_at }) => enqueued_at !== null)).toEqual([]);
        expect((await cancellationOf(expiring)).intent_cancel_enqueued_at).toBeNull();
        await dataSource.transaction(async (manager) => {
          await manager.query('SELECT id FROM order_refund WHERE reason = $1 FOR UPDATE NOWAIT', [
            RefundReason.DATE_CANCELLED,
          ]);
          await manager.query('SELECT id FROM seat_order WHERE id = $1 FOR UPDATE NOWAIT', [
            expiring,
          ]);
        });
        expect((await opsCheck()).queues).toBe('degraded');
        expect((await readiness()).statusCode).toBe(200);

        // The outage outlasts the relay's timeout many times over, its passes failing each time.
        while (performance.now() - outageStarted < OUTAGE_MS) {
          await expect(relay.relayDue()).rejects.toThrow();
          await delay(1_000);
        }
        expect((await dateRefunds()).filter(({ enqueued_at }) => enqueued_at !== null)).toEqual([]);
      } finally {
        await stack.unpause('redis');
        warnings.mockRestore();
      }
      const outageMs = performance.now() - outageStarted;
      process.stdout.write(`Redis paused for ${outageMs.toFixed(0)} ms\n`);

      await until('every refund and the cancellation made', async () => {
        await relay.relayDue().catch(() => 0);
        const refunds = await dateRefunds();
        return (
          refunds.every(({ refunded_at }) => refunded_at !== null) &&
          (await cancellationOf(expiring)).intent_cancel_owed_at === null
        );
      });

      for (const { idempotency_key } of await dateRefunds()) {
        expect(fake.calls.filter((call) => call === `refund ${idempotency_key}`)).toHaveLength(1);
      }
      expect(
        fake.calls.filter(
          (call) => call === `cancelIntent ${intentCancelIdempotencyKey(expiring)}`,
        ),
      ).toHaveLength(1);
      expect(fake.refundsMade).toBe(REFUNDS);
      const refunded = await dataSource.query<{ aggregateid: string; events: number }[]>(
        `SELECT aggregateid, count(*)::int AS events FROM outbox_event
          WHERE type = 'ticketing.order.refunded.v1' GROUP BY aggregateid`,
      );
      expect(refunded).toHaveLength(REFUNDS);
      expect(refunded.every(({ events }) => events === 1)).toBe(true);
      const states = await dataSource.query<{ state: string; orders: number }[]>(
        `SELECT state, count(*)::int AS orders FROM seat_order WHERE date_id = $1 GROUP BY state`,
        [CANCELLED_DATE],
      );
      expect(states).toEqual([{ state: OrderState.REFUNDED, orders: REFUNDS }]);
      await until(
        'the queues empty',
        async () => (await checkProviderCallQueues(stack.redis.url)).status === 'up',
      );
      expect(await opsCheck()).toEqual({ queues: 'up', dead: 'up', waiting: 'up' });
    },
    CASE_MS,
  );
});
