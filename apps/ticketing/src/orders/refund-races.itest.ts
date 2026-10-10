import { setTimeout as delay } from 'node:timers/promises';

import {
  OrderRefundedSchema,
  RefundReason as WireRefundReason,
  DateOutcome as WireDateOutcome,
} from '@arthome-platform/events';
import { Outcome } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  httpApp,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { BullModule } from '@nestjs/bullmq';
import { CommandBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FixedClock,
  MINUTE_MS,
  OrderErrorCode,
  OrderState,
  PaymentEventKind,
  PriceTier,
  RefundReason,
  SeatCancelReason,
  SeatState,
  Service,
} from '@arthome/core';

import { ExpireDueHolds } from './expire-due-holds.command.js';
import { HoldExpirySweeper } from './hold-expiry-sweeper.js';
import { HoldExpiryModule } from './hold-expiry.module.js';
import type { PurchasedSeats } from './order-views.js';
import { OrdersModule } from './orders.module.js';
import type { PurchaseAnswer } from './purchase-seat.command.js';
import { CLOCK } from '../clock.js';
import { DateOutcomeSweeper } from '../date-outcomes/date-outcome-sweeper.js';
import { DateOutcomesModule } from '../date-outcomes/date-outcomes.module.js';
import { SettleDateOutcomes } from '../date-outcomes/settle-date-outcomes.command.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { delivered, outcomeDeclared } from '../itest/catalog-messages.js';
import { gateInserts, holdAdvisoryLock, untilWaitingOnAdvisoryLock } from '../itest/locks.js';
import {
  expectLedgerHolds as expectLedger,
  madeTotalOf,
  ordersOf as ledgerOrdersOf,
  outboxOf as ledgerOutboxOf,
  raced,
  seatCancellationsPerSeat as cancellationsPerSeat,
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
  seatRefundOf,
} from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { ApplyPaymentEvents } from '../payments/apply-payment-events.command.js';
import {
  FakePaymentProvider,
  FakePaymentScenario,
  intentRefOf,
  type SignedWebhook,
} from '../payments/fake-payment-provider.js';
import { OwedCallRelay, ProviderCallProducer } from '../payments/owed-call-relay.js';
import { PaymentWebhooksModule } from '../payments/payment-webhooks.module.js';
import { PaymentWorker } from '../payments/payment-worker.js';
import { PaymentWorkerModule } from '../payments/payment-worker.module.js';
import {
  PROVIDER_CALL_SCHEDULES,
  type ProviderCallSchedules,
} from '../payments/provider-call-queues.js';
import { ProviderCallQueuesModule } from '../payments/provider-call-queues.module.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { SeatsModule } from '../seats/seats.module.js';

/**
 * adr-ticketing.md §12's refund racing a payment, on a real Postgres and a Redis of the file's own,
 *   the worker's queue making the refunds: a date's cancellation against payments confirmed before,
 *   during and after its settlement, late payments, two paths to one refund, and a viewer's or the
 *   studio's refund against the date's. Each race runs at least 20 orders at once, then the ledger
 *   is checked: every seat accounted for, refunds never above what was paid, one provider refund
 *   per key and of the amount its row owes.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 180_000;

const PREFIX = '{ticketing-refund-races-itest}';
const SHORT: ProviderCallSchedules = { refunds: [100, 200], intentCancellations: [100] };
const NOW = '2026-10-08T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const HOLD_MS = 15 * MINUTE_MS;
const CHANNEL = '01a0d20c-0000-7000-8000-000000000001';
const RACERS = 20;
/** Concurrent passes of the payment worker and of the settlement, as replicas run them. */
const PASSES = 4;
const VIEWER_GATE_LOCK = 4_242_001;

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let clock: FixedClock;
let fake: FakePaymentProvider;
let relay: OwedCallRelay;
let dates = 0;

const commands = (): CommandBus => app.get(CommandBus);

async function dateOnSale(capacity: number): Promise<string> {
  dates += 1;
  const dateId = `01a0d200-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await putOnSale(
    commands(),
    { dateId, channelId: CHANNEL, capacity, startsAt: STARTS_AT },
    clock.now(),
  );
  return dateId;
}

async function bought(dateId: string, quantity: number): Promise<PurchasedSeats> {
  const answer: PurchaseAnswer = await commands().execute(purchaseOf(dateId, quantity));
  return answer.response.envelope.data as PurchasedSeats;
}

async function awaitingOrders(dateId: string, count: number): Promise<string[]> {
  fake.scenarioOf = () => FakePaymentScenario.REQUIRE_ACTION;
  const orderIds: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const quantity = (n % 2) + 1;
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

async function recordCompletions(orderIds: readonly string[]): Promise<void> {
  for (const orderId of orderIds) await record(fake.completeAction(intentRefOf(orderId)));
}

const applyEvents = (batch = 100): Promise<unknown> =>
  commands().execute(new ApplyPaymentEvents(batch));

const settle = (orderBatch?: number): Promise<number> =>
  commands().execute(new SettleDateOutcomes(orderBatch));

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

async function settledAt(dateId: string): Promise<Date | null> {
  const [row] = await dataSource.query<{ settled_at: Date | null }[]>(
    'SELECT settled_at FROM date_outcome_settlement WHERE date_id = $1',
    [dateId],
  );
  return row?.settled_at ?? null;
}

async function settleUntilSettled(dateId: string): Promise<void> {
  await until('the date settled', async () => {
    await settle();
    return (await settledAt(dateId)) !== null;
  });
}

/** The worker's relay and refund queue, until each refund of the date is made or given up on. */
async function drainRefunds(dateId: string): Promise<void> {
  await until('every refund of the date made', async () => {
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

/** Every order of a cancelled date refunded once and in full, `date_cancelled`, with its events. */
async function expectRefundedOnceDateCancelled(
  dateId: string,
  orderIds: readonly string[],
): Promise<void> {
  const orders = await ordersOf(dateId);
  for (const orderId of orderIds) {
    const order = orders.get(orderId);
    expect(order, orderId).toMatchObject({
      state: OrderState.REFUNDED,
      refunds: [
        { reason: RefundReason.DATE_CANCELLED, amount_minor: order?.total_minor, made: true },
      ],
    });
    const refunded = (await outboxOf(orderId, 'ticketing.order.refunded.v1')).map(
      ({ payload }) => fromBinary(OrderRefundedSchema, payload).refundReason,
    );
    expect(refunded, orderId).toEqual([WireRefundReason.DATE_CANCELLED]);
  }
}

const ordersOf = (dateId: string) => ledgerOrdersOf(dataSource, dateId);
const outboxOf = (aggregateId: string, type: string) =>
  ledgerOutboxOf(dataSource, aggregateId, type);
const seatsOf = (dateId: string) => ledgerSeatsOf(dataSource, dateId);
const seatCancellationsPerSeat = (dateId: string) => cancellationsPerSeat(dataSource, dateId);
const expectLedgerHolds = (dateId: string) => expectLedger(dataSource, fake, dateId);

beforeAll(async () => {
  stack = await startStack({ postgres: true, redis: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_refund_races_itest');
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

describe('a cancellation racing payments', () => {
  it(
    'refunds every order once, date_cancelled, whether paid before, with, during or after its settlement',
    async () => {
      const dateId = await dateOnSale(4 * RACERS * 2);
      const paidBefore = await awaitingOrders(dateId, RACERS);
      const paidWithTheFact = await awaitingOrders(dateId, RACERS);
      const paidDuringSettlement = await awaitingOrders(dateId, RACERS);
      const paidAfterSettlement = await awaitingOrders(dateId, RACERS);

      await recordCompletions(paidBefore);
      await applyEvents();

      await recordCompletions(paidWithTheFact);
      expect(await raced([() => cancelDate(dateId), ...times(PASSES, () => applyEvents(5))])).toBe(
        0,
      );
      await applyEvents();

      await recordCompletions(paidDuringSettlement);
      expect(
        await raced([...times(PASSES, () => settle(5)), ...times(PASSES, () => applyEvents(5))]),
      ).toBe(0);
      await applyEvents();
      for (let pass = 0; pass < 20; pass += 1) await settle();
      expect(await settledAt(dateId)).toBeNull();

      clock.advance(HOLD_MS);
      await commands().execute(new ExpireDueHolds());
      await settleUntilSettled(dateId);
      await recordCompletions(paidAfterSettlement);
      expect(await raced(times(PASSES, () => applyEvents(5)))).toBe(0);
      await applyEvents();

      await drainRefunds(dateId);

      const everyOrder = [
        ...paidBefore,
        ...paidWithTheFact,
        ...paidDuringSettlement,
        ...paidAfterSettlement,
      ];
      await expectRefundedOnceDateCancelled(dateId, everyOrder);
      const orders = await ordersOf(dateId);
      expect([...orders.values()].filter(({ state }) => state === OrderState.PAID)).toEqual([]);
      for (const orderId of paidAfterSettlement) expect(orders.get(orderId)?.seats).toBe(0);
      const cancellations = await seatCancellationsPerSeat(dateId);
      for (const seat of await seatsOf(dateId)) {
        expect(seat.state).toBe(SeatState.REFUNDED);
        expect(cancellations.get(seat.id)).toEqual(['DATE_CANCELLED']);
      }
      await expectLedgerHolds(dateId);
    },
    CASE_MS,
  );
});

describe('a late payment on a cancelled date (D-082 with D-097)', () => {
  it(
    'refunds each payment past its hold once, date_cancelled, never hold_expired_capacity_lost, no seat',
    async () => {
      const dateId = await dateOnSale(RACERS * 2);
      const late = await awaitingOrders(dateId, RACERS);
      clock.advance(HOLD_MS);
      await commands().execute(new ExpireDueHolds());
      await cancelDate(dateId);
      await settleUntilSettled(dateId);

      await recordCompletions(late);
      expect(await raced(times(PASSES, () => applyEvents(5)))).toBe(0);
      await applyEvents();
      await drainRefunds(dateId);

      await expectRefundedOnceDateCancelled(dateId, late);
      for (const order of (await ordersOf(dateId)).values()) expect(order.seats).toBe(0);
      await expectLedgerHolds(dateId);
    },
    CASE_MS,
  );
});

describe('two paths to one refund', () => {
  it(
    "makes one provider call and one order.refunded while a duplicated success is applied by two workers during the refund's job",
    async () => {
      const dateId = await dateOnSale(RACERS * 2);
      const paid: string[] = [];
      for (let n = 0; n < RACERS / 2; n += 1) paid.push((await bought(dateId, 1)).order.id);
      const awaiting = await awaitingOrders(dateId, RACERS / 2);
      await cancelDate(dateId);
      expect(await settle()).toBe(paid.length);

      for (const orderId of paid) {
        await record(fake.webhookOf(intentRefOf(orderId), PaymentEventKind.INTENT_SUCCEEDED));
        await record(fake.webhookOf(intentRefOf(orderId), PaymentEventKind.INTENT_SUCCEEDED));
      }
      for (const orderId of awaiting) {
        await record(fake.completeAction(intentRefOf(orderId)));
        await record(fake.webhookOf(intentRefOf(orderId), PaymentEventKind.INTENT_SUCCEEDED));
      }
      expect(
        await raced([() => relay.relayDue(), () => applyEvents(RACERS), () => applyEvents(RACERS)]),
      ).toBe(0);
      await applyEvents();
      await drainRefunds(dateId);
      await settleUntilSettled(dateId);

      await expectRefundedOnceDateCancelled(dateId, [...paid, ...awaiting]);
      const inbox = await dataSource.query<{ applied: boolean }[]>(
        `SELECT applied_at IS NOT NULL AND dead_at IS NULL AS applied FROM stripe_event_inbox
          WHERE order_id = ANY($1)`,
        [[...paid, ...awaiting]],
      );
      expect(inbox).toHaveLength(2 * RACERS);
      expect(inbox.every(({ applied }) => applied)).toBe(true);
      await expectLedgerHolds(dateId);
    },
    CASE_MS,
  );
});

describe("a seat's cancellation racing the date's", () => {
  it(
    'refunds at most what was paid, each seat cancelled once, no key reused for another amount',
    async () => {
      const dateId = await dateOnSale(RACERS * 3);
      const purchases: PurchasedSeats[] = [];
      for (let n = 0; n < RACERS; n += 1) purchases.push(await bought(dateId, 3));

      const refused = await raced(
        [
          ...purchases.map(
            ({ tickets }) =>
              () =>
                commands().execute(seatCancellationOf(tickets[0]?.seatId ?? '')),
          ),
          () => cancelDate(dateId),
          ...times(PASSES, () => settle(5)),
        ],
        [OrderErrorCode.SEAT_NOT_ACTIVE],
      );
      await settleUntilSettled(dateId);
      await drainRefunds(dateId);

      const orders = await ordersOf(dateId);
      for (const { order } of purchases) {
        const ledger = orders.get(order.id);
        if (ledger === undefined) throw new Error(`no order ${order.id}`);
        expect(ledger.state).toBe(OrderState.REFUNDED);
        expect(madeTotalOf(ledger)).toBe(Number(ledger.total_minor));
      }
      const cancellations = await seatCancellationsPerSeat(dateId);
      const firstSeats = new Set(purchases.map(({ tickets }) => tickets[0]?.seatId));
      const reasons = { viewerFirst: 0, viewerAfterTheFact: 0, settledFirst: 0 };
      for (const seat of await seatsOf(dateId)) {
        expect(seat.state).toBe(SeatState.REFUNDED);
        expect(cancellations.get(seat.id)).toHaveLength(1);
        if (!firstSeats.has(seat.id)) continue;
        if (seat.cancel_reason === SeatCancelReason.VIEWER_REQUEST) reasons.viewerFirst += 1;
        else if (seat.cancel_reason === SeatCancelReason.DATE_CANCELLED) {
          const viewer = orders
            .get(seat.order_id)
            ?.refunds.some(({ reason }) => reason === RefundReason.DATE_CANCELLED);
          if (viewer === true && (orders.get(seat.order_id)?.refunds.length ?? 0) > 1) {
            reasons.viewerAfterTheFact += 1;
          } else reasons.settledFirst += 1;
        }
      }
      expect(reasons.settledFirst).toBe(refused);
      process.stdout.write(`seat cancellations racing the date's: ${JSON.stringify(reasons)}\n`);
      await expectLedgerHolds(dateId);
    },
    CASE_MS,
  );

  it(
    'refunds date_cancelled and gives no seat back to sale when the date is cancelled during the cancellation',
    async () => {
      const dateId = await dateOnSale(3);
      const { order, tickets } = await bought(dateId, 3);
      const seatId = tickets[0]?.seatId ?? '';
      const [countersBefore] = await dataSource.query<unknown[]>(
        'SELECT seats_available, seats_sold FROM date_sales WHERE date_id = $1',
        [dateId],
      );
      const ungate = await gateInserts(dataSource, {
        name: 'itest_viewer_cancellation_gate',
        table: 'outbox_event',
        when: `NEW.type = 'ticketing.seat.cancelled.v1' AND NEW.aggregateid = '${dateId}'`,
        key: VIEWER_GATE_LOCK,
      });
      try {
        const release = await holdAdvisoryLock(dataSource, VIEWER_GATE_LOCK);
        let cancelling: Promise<unknown>;
        try {
          cancelling = commands().execute(seatCancellationOf(seatId));
          await untilWaitingOnAdvisoryLock(dataSource);
          await cancelDate(dateId);
        } finally {
          await release();
        }
        await cancelling;
      } finally {
        await ungate();
      }

      const seat = (await seatsOf(dateId)).find(({ id }) => id === seatId);
      expect(seat).toMatchObject({
        state: SeatState.CANCELLED,
        cancel_reason: SeatCancelReason.DATE_CANCELLED,
      });
      expect((await ordersOf(dateId)).get(order.id)?.refunds).toEqual([
        {
          reason: RefundReason.DATE_CANCELLED,
          amount_minor: String(FULL_PRICE_MINOR),
          made: false,
          dead: false,
        },
      ]);
      expect((await seatCancellationsPerSeat(dateId)).get(seatId)).toEqual(['DATE_CANCELLED']);
      const [countersAfter] = await dataSource.query<unknown[]>(
        'SELECT seats_available, seats_sold FROM date_sales WHERE date_id = $1',
        [dateId],
      );
      expect(countersAfter).toEqual(countersBefore);

      await settleUntilSettled(dateId);
      await drainRefunds(dateId);
      await expectRefundedOnceDateCancelled(dateId, []);
      const ledger = (await ordersOf(dateId)).get(order.id);
      expect(ledger?.state).toBe(OrderState.REFUNDED);
      expect(ledger && madeTotalOf(ledger)).toBe(3 * FULL_PRICE_MINOR);
      await expectLedgerHolds(dateId);
    },
    CASE_MS,
  );
});

describe("a studio refund racing the date's", () => {
  it(
    'refunds the paid total once, the order ending refunded',
    async () => {
      const dateId = await dateOnSale(RACERS * 2);
      const purchases: PurchasedSeats[] = [];
      for (let n = 0; n < RACERS; n += 1) purchases.push(await bought(dateId, 2));

      await raced(
        [
          ...purchases.map(
            ({ tickets }) =>
              () =>
                commands().execute(
                  seatRefundOf(tickets[0]?.seatId ?? '', {
                    refundReasonCode: RefundReason.GOODWILL,
                    partialAmountMinor: 500,
                  }),
                ),
          ),
          () => cancelDate(dateId),
          ...times(PASSES, () => settle(5)),
        ],
        [OrderErrorCode.SEAT_NOT_ACTIVE, OrderErrorCode.REFUND_AMOUNT_EXCEEDS_REMAINING],
      );
      await settleUntilSettled(dateId);
      await drainRefunds(dateId);

      const orders = await ordersOf(dateId);
      const studioFirst = { yes: 0, no: 0 };
      for (const { order } of purchases) {
        const ledger = orders.get(order.id);
        if (ledger === undefined) throw new Error(`no order ${order.id}`);
        expect(ledger.state).toBe(OrderState.REFUNDED);
        expect(madeTotalOf(ledger)).toBe(Number(ledger.total_minor));
        if (ledger.refunds.some(({ reason }) => reason === RefundReason.GOODWILL))
          studioFirst.yes += 1;
        else studioFirst.no += 1;
      }
      process.stdout.write(`studio refunds racing the date's: ${JSON.stringify(studioFirst)}\n`);
      await expectLedgerHolds(dateId);
    },
    CASE_MS,
  );
});
