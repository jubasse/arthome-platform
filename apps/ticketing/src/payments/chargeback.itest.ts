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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FixedClock,
  OrderState,
  PaymentEventKind,
  PriceTier,
  RefundReason,
  SeatCancelReason,
  SeatState,
  Service,
} from '@arthome/core';

import { ApplyPaymentEvents } from './apply-payment-events.command.js';
import {
  FakePaymentProvider,
  FakePaymentScenario,
  intentRefOf,
  type SignedWebhook,
} from './fake-payment-provider.js';
import { OwedCallRelay, ProviderCallProducer } from './owed-call-relay.js';
import { PaymentWebhooksModule } from './payment-webhooks.module.js';
import { PaymentWorker } from './payment-worker.js';
import { PaymentWorkerModule } from './payment-worker.module.js';
import { checkProviderCallsDead } from './provider-call-checks.js';
import { PROVIDER_CALL_SCHEDULES, type ProviderCallSchedules } from './provider-call-queues.js';
import { ProviderCallQueuesModule } from './provider-call-queues.module.js';
import { CLOCK } from '../clock.js';
import { DateOutcomeSweeper } from '../date-outcomes/date-outcome-sweeper.js';
import { DateOutcomesModule } from '../date-outcomes/date-outcomes.module.js';
import { SettleDateOutcomes } from '../date-outcomes/settle-date-outcomes.command.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { delivered, outcomeDeclared } from '../itest/catalog-messages.js';
import {
  expectLedgerHolds as expectLedger,
  ordersOf as ledgerOrdersOf,
  outboxOf as ledgerOutboxOf,
  raced,
  seatCancellationsPerSeat,
  seatsOf as ledgerSeatsOf,
  times,
} from '../itest/race-ledger.js';
import {
  FULL_PRICE_MINOR,
  ITEST_BUYER_ACCOUNT_ID,
  nextKey,
  purchaseOf,
  putOnSale,
  seatCancellationOf,
} from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { HoldExpirySweeper } from '../orders/hold-expiry-sweeper.js';
import { HoldExpiryModule } from '../orders/hold-expiry.module.js';
import type { PurchasedSeats } from '../orders/order-views.js';
import { OrdersModule } from '../orders/orders.module.js';
import type { PurchaseAnswer } from '../orders/purchase-seat.command.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { SeatsModule } from '../seats/seats.module.js';

/**
 * A chargeback (adr-payments.md §8, §9), on a real Postgres and a Redis of the file's own, 20
 *   orders at once each time: `disputed`, forward only, the seats left active and nothing asked of
 *   the provider; a dispute before the confirmation it follows; a dispute racing a cancelled
 *   date's refund both ways; a refunded order disputed; a viewer's cancellation on a disputed
 *   order. A refund given up on a disputed order is counted apart by `provider_calls_dead`.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 120_000;

const PREFIX = '{ticketing-chargeback-itest}';
const SHORT: ProviderCallSchedules = { refunds: [100, 200], intentCancellations: [100] };
const REFUND_ATTEMPTS = SHORT.refunds.length + 1;
const NOW = '2026-10-08T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const CHANNEL = '01a0d30c-0000-7000-8000-000000000001';
const RACERS = 20;
const PASSES = 4;

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let clock: FixedClock;
let fake: FakePaymentProvider;
let relay: OwedCallRelay;
let dates = 0;

const commands = (): CommandBus => app.get(CommandBus);
const ordersOf = (dateId: string) => ledgerOrdersOf(dataSource, dateId);
const outboxOf = (aggregateId: string, type: string) =>
  ledgerOutboxOf(dataSource, aggregateId, type);
const seatsOf = (dateId: string) => ledgerSeatsOf(dataSource, dateId);
const expectLedgerHolds = (dateId: string) => expectLedger(dataSource, fake, dateId);

async function dateOnSale(capacity: number): Promise<string> {
  dates += 1;
  const dateId = `01a0d300-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await putOnSale(
    commands(),
    { dateId, channelId: CHANNEL, capacity, startsAt: STARTS_AT },
    clock.now(),
  );
  return dateId;
}

async function paidOrders(dateId: string, quantity: number): Promise<PurchasedSeats[]> {
  const purchases: PurchasedSeats[] = [];
  for (let n = 0; n < RACERS; n += 1) {
    const answer: PurchaseAnswer = await commands().execute(purchaseOf(dateId, quantity));
    purchases.push(answer.response.envelope.data as PurchasedSeats);
  }
  return purchases;
}

async function awaitingOrders(dateId: string, quantity: number): Promise<string[]> {
  fake.scenarioOf = () => FakePaymentScenario.REQUIRE_ACTION;
  const orderIds: string[] = [];
  for (let n = 0; n < RACERS; n += 1) {
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
    orderIds.push(answer.json<{ data: { orderId: string } }>().data.orderId);
  }
  fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
  return orderIds;
}

async function record({ body, signature }: SignedWebhook): Promise<void> {
  const answer = await app.inject({
    method: 'POST',
    url: '/v1/payments/webhook',
    headers: { 'content-type': 'application/json', [fake.signatureHeader]: signature },
    payload: body,
  });
  expect(answer.statusCode).toBe(200);
}

/** Each order's dispute recorded, twice when `duplicated`, then applied by concurrent workers. */
async function disputesApplied(orderIds: readonly string[], duplicated = false): Promise<void> {
  for (const orderId of orderIds) {
    const dispute = fake.disputeOpened(intentRefOf(orderId));
    await record(dispute);
    if (duplicated) await record(dispute);
  }
  expect(await raced(times(PASSES, () => applyEvents(5)))).toBe(0);
  await applyEvents();
}

const applyEvents = (batch = 100): Promise<unknown> =>
  commands().execute(new ApplyPaymentEvents(batch));

async function cancelDate(dateId: string): Promise<void> {
  const applied = await applyCatalogDateMessage(
    commands(),
    delivered(outcomeDeclared(dateId, WireDateOutcome.CANCELLED, clock.now())),
  );
  expect(applied).toBe(Outcome.APPLIED);
}

async function until(what: string, ready: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await ready())) {
    if (performance.now() > deadline) throw new Error(`${what}, not within ${timeoutMs} ms`);
    await delay(50);
  }
}

async function settleUntilSettled(dateId: string): Promise<void> {
  await until('the date settled', async () => {
    await commands().execute(new SettleDateOutcomes());
    const [row] = await dataSource.query<{ settled: boolean }[]>(
      'SELECT settled_at IS NOT NULL AS settled FROM date_outcome_settlement WHERE date_id = $1',
      [dateId],
    );
    return row?.settled === true;
  });
}

/** The worker's relay and refund queue, until each refund of the date is made or given up on. */
async function drainRefunds(dateId: string): Promise<void> {
  await until('every refund of the date settled', async () => {
    await relay.relayDue();
    const [left] = await dataSource.query<{ left: number }[]>(
      `SELECT count(*)::int AS left FROM order_refund AS refund
         JOIN seat_order AS placed ON placed.id = refund.order_id
        WHERE placed.date_id = $1 AND refund.refunded_at IS NULL AND refund.dead_at IS NULL`,
      [dateId],
    );
    return left?.left === 0;
  });
}

const refundCallsOf = (key: string): number =>
  fake.calls.filter((call) => call === `refund ${key}`).length;

function keysOf(orderIds: readonly string[]) {
  return dataSource.query<{ id: string; order_id: string; idempotency_key: string }[]>(
    'SELECT id, order_id, idempotency_key FROM order_refund WHERE order_id = ANY($1)',
    [orderIds],
  );
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, redis: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_chargeback_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock(NOW);
  fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  app = await httpApp({
    imports: [
      OrdersModule,
      SeatsModule,
      PaymentWebhooksModule,
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
    rawBody: true,
    overrides: [
      [CLOCK, clock],
      [FakePaymentProvider, fake],
      [PUBLIC_WEB_ORIGIN, 'http://storefront.test'],
      [PROVIDER_CALL_SCHEDULES, SHORT],
      [PaymentWorker, {}],
      [HoldExpirySweeper, {}],
      [OwedCallRelay, {}],
      [DateOutcomeSweeper, {}],
    ],
  });
  relay = new OwedCallRelay(dataSource, app.get(ProviderCallProducer), clock, SHORT);
}, STARTUP_MS);

beforeEach(() => {
  fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
});

afterAll(async () => {
  await app?.close();
  await stack?.stop();
});

describe('a dispute on a paid order', () => {
  it(
    'marks it disputed, its seats active, no seat.cancelled, no provider call, a duplicate applied once',
    async () => {
      const dateId = await dateOnSale(RACERS * 2);
      const orderIds = (await paidOrders(dateId, 2)).map(({ order }) => order.id);
      const callsBefore = fake.calls.length;

      await disputesApplied(orderIds, true);

      const orders = await ordersOf(dateId);
      for (const orderId of orderIds) {
        expect(orders.get(orderId)).toMatchObject({ state: OrderState.DISPUTED, refunds: [] });
      }
      expect((await seatsOf(dateId)).every(({ state }) => state === SeatState.ACTIVE)).toBe(true);
      expect(await outboxOf(dateId, 'ticketing.seat.cancelled.v1')).toEqual([]);
      expect(fake.calls.slice(callsBefore)).toEqual([]);
      const inbox = await dataSource.query<{ events: number }[]>(
        `SELECT count(*)::int AS events FROM stripe_event_inbox
          WHERE order_id = ANY($1) AND kind = $2`,
        [orderIds, PaymentEventKind.DISPUTE_OPENED],
      );
      expect(inbox).toEqual([{ events: RACERS }]);
      await expectLedgerHolds(dateId);
    },
    CASE_MS,
  );
});

describe('a dispute before the confirmation it follows', () => {
  it(
    'settles the payment first, then disputed, its seats created once and active',
    async () => {
      const dateId = await dateOnSale(RACERS * 2);
      const orderIds = await awaitingOrders(dateId, 2);

      await disputesApplied(orderIds);
      for (const orderId of orderIds) {
        await record(fake.webhookOf(intentRefOf(orderId), PaymentEventKind.INTENT_SUCCEEDED));
      }
      expect(await raced(times(PASSES, () => applyEvents(5)))).toBe(0);
      await applyEvents();

      const orders = await ordersOf(dateId);
      for (const orderId of orderIds) {
        expect(orders.get(orderId)).toMatchObject({
          state: OrderState.DISPUTED,
          refunds: [],
          seats: 2,
        });
        expect(await outboxOf(orderId, 'ticketing.order.paid.v1')).toHaveLength(1);
      }
      expect((await seatsOf(dateId)).every(({ state }) => state === SeatState.ACTIVE)).toBe(true);
      expect(await outboxOf(dateId, 'ticketing.seat.activated.v1')).toHaveLength(2 * RACERS);
      await expectLedgerHolds(dateId);
    },
    CASE_MS,
  );
});

describe("a dispute racing a cancelled date's refund", () => {
  it(
    'disputed first: no refund owed, the seats cancelled with none',
    async () => {
      const dateId = await dateOnSale(RACERS * 2);
      const orderIds = (await paidOrders(dateId, 2)).map(({ order }) => order.id);
      const callsBefore = fake.calls.length;

      await disputesApplied(orderIds);
      await cancelDate(dateId);
      await settleUntilSettled(dateId);

      const orders = await ordersOf(dateId);
      for (const orderId of orderIds) {
        expect(orders.get(orderId)).toMatchObject({ state: OrderState.DISPUTED, refunds: [] });
      }
      const cancellations = await seatCancellationsPerSeat(dataSource, dateId);
      for (const seat of await seatsOf(dateId)) {
        expect(seat).toMatchObject({
          state: SeatState.CANCELLED,
          cancel_reason: SeatCancelReason.DATE_CANCELLED,
        });
        expect(cancellations.get(seat.id)).toEqual(['DATE_CANCELLED']);
      }
      expect(fake.calls.slice(callsBefore)).toEqual([]);
      await expectLedgerHolds(dateId);
    },
    CASE_MS,
  );

  it(
    'refund owed first: refused on the disputed charge, given up within its bound, the order disputed',
    async () => {
      const dateId = await dateOnSale(RACERS * 2);
      const orderIds = (await paidOrders(dateId, 2)).map(({ order }) => order.id);
      await cancelDate(dateId);
      await settleUntilSettled(dateId);
      const madeBefore = fake.refundsMade;
      // The charges disputed at the provider; half the webhooks race the refunds' jobs, the other
      //   half arrive only once those refunds were given up on.
      const disputes = new Map(
        orderIds.map((orderId) => [orderId, fake.disputeOpened(intentRefOf(orderId))]),
      );
      const racing = orderIds.slice(0, RACERS / 2);
      const late = orderIds.slice(RACERS / 2);
      const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      let loggedErrors: unknown[][];
      try {
        for (const orderId of racing) {
          const dispute = disputes.get(orderId);
          if (dispute !== undefined) await record(dispute);
        }
        expect(await raced([() => relay.relayDue(), ...times(PASSES, () => applyEvents(2))])).toBe(
          0,
        );
        await applyEvents();
        await drainRefunds(dateId);
        loggedErrors = [...errors.mock.calls];
      } finally {
        errors.mockRestore();
      }

      const keys = await keysOf(orderIds);
      expect(keys).toHaveLength(RACERS);
      for (const { order_id, idempotency_key } of keys) {
        const calls = refundCallsOf(idempotency_key);
        expect(calls, idempotency_key).toBeLessThanOrEqual(REFUND_ATTEMPTS);
        if (late.includes(order_id)) expect(calls, idempotency_key).toBe(REFUND_ATTEMPTS);
      }
      const lateRefunds = keys.filter(({ order_id }) => late.includes(order_id));
      const lateErrors = loggedErrors.filter(([message]) =>
        lateRefunds.some(({ id }) => String(message).includes(id)),
      );
      expect(lateErrors).toHaveLength(late.length);
      for (const [message] of lateErrors) {
        expect(String(message)).toContain('money is held without a seat');
      }
      expect(await checkProviderCallsDead(dataSource)).toMatchObject({
        status: 'degraded',
        detail: { refunds: late.length, refundsHeldByDisputes: racing.length },
      });

      for (const orderId of late) {
        const dispute = disputes.get(orderId);
        if (dispute !== undefined) await record(dispute);
      }
      await applyEvents();

      expect(fake.refundsMade).toBe(madeBefore);
      const orders = await ordersOf(dateId);
      for (const orderId of orderIds) {
        expect(orders.get(orderId)).toMatchObject({
          state: OrderState.DISPUTED,
          refunds: [{ reason: RefundReason.DATE_CANCELLED, made: false, dead: true }],
        });
      }
      expect(await checkProviderCallsDead(dataSource)).toMatchObject({
        status: 'up',
        detail: { refunds: 0, refundsHeldByDisputes: RACERS },
      });
      await expectLedgerHolds(dateId);
    },
    CASE_MS,
  );
});

describe('a refunded order then disputed', () => {
  it(
    'is disputed, and no second refund is made',
    async () => {
      const dateId = await dateOnSale(RACERS * 2);
      const orderIds = (await paidOrders(dateId, 2)).map(({ order }) => order.id);
      await cancelDate(dateId);
      await settleUntilSettled(dateId);
      await drainRefunds(dateId);
      const madeBefore = fake.refundsMade;

      await disputesApplied(orderIds);
      await drainRefunds(dateId);

      const orders = await ordersOf(dateId);
      for (const orderId of orderIds) {
        expect(orders.get(orderId)).toMatchObject({
          state: OrderState.DISPUTED,
          refunds: [{ reason: RefundReason.DATE_CANCELLED, made: true }],
        });
        expect(await outboxOf(orderId, 'ticketing.order.refunded.v1')).toHaveLength(1);
      }
      for (const { idempotency_key } of await keysOf(orderIds)) {
        expect(refundCallsOf(idempotency_key)).toBe(1);
      }
      expect(fake.refundsMade).toBe(madeBefore);
      await expectLedgerHolds(dateId);
    },
    CASE_MS,
  );

  it(
    "cancels a viewer's seat on a disputed order with no refund",
    async () => {
      const dateId = await dateOnSale(RACERS * 2);
      const purchases = await paidOrders(dateId, 2);
      await disputesApplied(purchases.map(({ order }) => order.id));
      const callsBefore = fake.calls.length;

      expect(
        await raced(
          purchases.map(
            ({ tickets }) =>
              () =>
                commands().execute(seatCancellationOf(tickets[0]?.seatId ?? '')),
          ),
        ),
      ).toBe(0);

      const orders = await ordersOf(dateId);
      const seats = await seatsOf(dateId);
      for (const { order, tickets } of purchases) {
        expect(orders.get(order.id)).toMatchObject({ state: OrderState.DISPUTED, refunds: [] });
        const cancelled = seats.find(({ id }) => id === tickets[0]?.seatId);
        expect(cancelled).toMatchObject({
          state: SeatState.CANCELLED,
          cancel_reason: SeatCancelReason.VIEWER_REQUEST,
        });
        const other = seats.find(({ id }) => id === tickets[1]?.seatId);
        expect(other?.state).toBe(SeatState.ACTIVE);
      }
      expect(fake.calls.slice(callsBefore)).toEqual([]);
      await expectLedgerHolds(dateId);
    },
    CASE_MS,
  );
});
