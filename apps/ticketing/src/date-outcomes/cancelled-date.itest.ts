import { setTimeout as delay } from 'node:timers/promises';

import {
  DateOutcome as WireDateOutcome,
  OrderRefundedSchema,
  RefundReason as WireRefundReason,
  SeatCancelReason as WireSeatCancelReason,
  SeatCancelledSchema,
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FixedClock,
  OrderState,
  RefundReason,
  SeatCancelReason,
  SeatState,
  refundIdempotencyKey,
  seatCancelDeadline,
} from '@arthome/core';

import { DateOutcomeSweeper } from './date-outcome-sweeper.js';
import { DateOutcomesModule } from './date-outcomes.module.js';
import { SettleDateOutcomes } from './settle-date-outcomes.command.js';
import { CLOCK } from '../clock.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { delivered, outcomeDeclared } from '../itest/catalog-messages.js';
import { seedPaidOrders, seededOrderId } from '../itest/paid-orders.js';
import { FULL_PRICE_MINOR, putOnSale } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { FakePaymentProvider } from '../payments/fake-payment-provider.js';
import { OwedCallRelay, ProviderCallProducer } from '../payments/owed-call-relay.js';
import {
  PROVIDER_CALL_SCHEDULES,
  type ProviderCallSchedules,
} from '../payments/provider-call-queues.js';
import { ProviderCallQueuesModule } from '../payments/provider-call-queues.module.js';

/**
 * A cancelled date settled (adr-ticketing.md §8, HANDOVER §0n): 1,200 paid orders refunded what
 *   is left of each, in batches of 500, their seats cancelled with their shares and announced on
 *   the date's key, then refunded by the worker's queue as it drains them.
 */

const STARTUP_MS = 240_000;
// 1,200 orders settled take about 20 s alone, three times that beside the other suites.
const SETTLE_MS = 180_000;
const DRAIN_MS = 180_000;

const PREFIX = '{ticketing-cancelled-date-itest}';
const SHORT: ProviderCallSchedules = { refunds: [100, 200], intentCancellations: [100] };
const NOW = '2026-10-02T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const CHANNEL = '01a0e30c-0000-7000-8000-000000000001';
const ACCOUNT = '01a0e3aa-0000-7000-8000-000000000001';
const DATE_ID = '01a0e300-0000-7000-8000-000000000001';
const SERIES = '01a0e301';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const ORDERS = 1_200;
const GOODWILL_ORDER = 8;
const GOODWILL_MINOR = 1_000;
const HELD_ORDER = 1;

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let clock: FixedClock;
let fake: FakePaymentProvider;

const commands = (): CommandBus => app.get(CommandBus);
const quantityOf = (n: number): number => (n % 4 === 0 ? 3 : 1);
const settle = (): Promise<number> => commands().execute(new SettleDateOutcomes());

async function until(what: string, ready: () => Promise<boolean>, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (!(await ready())) {
    if (performance.now() > deadline) throw new Error(`${what}, not within ${timeoutMs} ms`);
    await delay(200);
  }
}

async function countersOf(dateId: string) {
  const [row] = await dataSource.query<
    { seats_available: number; seats_sold: number; waitlist_count: number }[]
  >('SELECT seats_available, seats_sold, waitlist_count FROM date_sales WHERE date_id = $1', [
    dateId,
  ]);
  return row;
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, redis: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_cancelled_date_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock(NOW);
  fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  app = await httpApp({
    imports: [
      CatalogFactsModule,
      DateSalesModule,
      DateOutcomesModule,
      BullModule.forRoot({ connection: { url: stack.redis.url }, prefix: PREFIX }),
      ProviderCallQueuesModule,
    ],
    providers: EDGE_PROVIDERS,
    dataSource,
    overrides: [
      [CLOCK, clock],
      [FakePaymentProvider, fake],
      [PROVIDER_CALL_SCHEDULES, SHORT],
      [OwedCallRelay, {}],
      [DateOutcomeSweeper, {}],
    ],
  });
}, STARTUP_MS);

afterAll(async () => {
  await app?.close();
  await stack?.stop();
});

describe('a cancelled date', () => {
  it(
    'refunds each paid order what is left, in batches of 500, and cancels its seats with their shares',
    async () => {
      await putOnSale(
        commands(),
        { dateId: DATE_ID, channelId: CHANNEL, capacity: 10, startsAt: STARTS_AT },
        NOW,
      );
      const orderIds = await seedPaidOrders(dataSource, {
        dateId: DATE_ID,
        channelId: CHANNEL,
        series: SERIES,
        quantities: Array.from({ length: ORDERS }, (_, index) => quantityOf(index + 1)),
        accountId: ACCOUNT,
        cancelDeadline: seatCancelDeadline(STARTS_AT),
        paidAt: NOW,
      });
      const goodwillOrderId = seededOrderId(SERIES, GOODWILL_ORDER);
      await dataSource.query(
        `INSERT INTO order_refund (id, order_id, amount_minor, currency_code, reason,
                                   idempotency_key, owed_at, refund_ref, refunded_at)
         VALUES ('01a0e3ff-0000-7000-8000-000000000001', $1, $2, 'EUR', $3,
                 'refund:01a0e3ff-0000-7000-8000-000000000001', $4, 're_goodwill', $4)`,
        [goodwillOrderId, GOODWILL_MINOR, RefundReason.GOODWILL, new Date(NOW)],
      );
      await dataSource.query('UPDATE seat_order SET state = $2 WHERE id = $1', [
        goodwillOrderId,
        OrderState.PARTIALLY_REFUNDED,
      ]);
      const countersBefore = await countersOf(DATE_ID);
      const cancellation = outcomeDeclared(DATE_ID, WireDateOutcome.CANCELLED, NOW);
      const traced = delivered({
        ...cancellation,
        headers: { ...cancellation.headers, traceparent: TRACEPARENT },
      });

      expect(await applyCatalogDateMessage(commands(), traced)).toBe(Outcome.APPLIED);
      expect(await applyCatalogDateMessage(commands(), traced)).toBe(Outcome.DUPLICATE);

      const holder = dataSource.createQueryRunner();
      await holder.connect();
      const batches: number[] = [];
      try {
        await holder.startTransaction();
        await holder.query('SELECT id FROM seat_order WHERE id = $1 FOR UPDATE', [
          seededOrderId(SERIES, HELD_ORDER),
        ]);
        for (let pass = 0; pass < 3; pass += 1) batches.push(await settle());
        expect(await settle()).toBe(0);
      } finally {
        await holder.rollbackTransaction();
        await holder.release();
      }
      batches.push(await settle());
      await settle();

      expect(batches).toEqual([500, 500, 199, 1]);
      const [settlement] = await dataSource.query<{ settled: boolean }[]>(
        `SELECT settled_at IS NOT NULL AND waitlist_ended_at IS NOT NULL AS settled
           FROM date_outcome_settlement WHERE date_id = $1`,
        [DATE_ID],
      );
      expect(settlement?.settled).toBe(true);

      const refunds = await dataSource.query<
        {
          id: string;
          order_id: string;
          amount_minor: string;
          idempotency_key: string;
          seat_id: string | null;
          traceparent: string | null;
        }[]
      >(
        `SELECT id, order_id, amount_minor, idempotency_key, seat_id, traceparent
           FROM order_refund WHERE reason = $1`,
        [RefundReason.DATE_CANCELLED],
      );
      expect(refunds).toHaveLength(ORDERS);
      expect(new Set(refunds.map(({ order_id }) => order_id)).size).toBe(ORDERS);
      for (const refund of refunds) {
        const n = orderIds.indexOf(refund.order_id) + 1;
        const total = FULL_PRICE_MINOR * quantityOf(n);
        expect(refund).toMatchObject({
          amount_minor: String(n === GOODWILL_ORDER ? total - GOODWILL_MINOR : total),
          idempotency_key: refundIdempotencyKey(refund.id),
          seat_id: null,
          traceparent: TRACEPARENT,
        });
      }

      const seats = await dataSource.query<
        {
          order_id: string;
          state: string;
          cancel_reason: string | null;
          refund_id: string | null;
          refund_amount_minor: string | null;
        }[]
      >(
        `SELECT order_id, state, cancel_reason, refund_id, refund_amount_minor FROM seat
          WHERE date_id = $1 ORDER BY order_id, id`,
        [DATE_ID],
      );
      const refundOf = new Map(refunds.map((refund) => [refund.order_id, refund]));
      const sharedPerOrder = new Map<string, number>();
      for (const seat of seats) {
        expect(seat).toMatchObject({
          state: SeatState.CANCELLED,
          cancel_reason: SeatCancelReason.DATE_CANCELLED,
          refund_id: refundOf.get(seat.order_id)?.id,
        });
        sharedPerOrder.set(
          seat.order_id,
          (sharedPerOrder.get(seat.order_id) ?? 0) + Number(seat.refund_amount_minor),
        );
      }
      for (const refund of refunds) {
        expect(sharedPerOrder.get(refund.order_id)).toBe(Number(refund.amount_minor));
      }
      expect(
        seats
          .filter(({ order_id }) => order_id === goodwillOrderId)
          .map(({ refund_amount_minor }) => refund_amount_minor),
      ).toEqual(['2067', '2067', '2066']);

      const seatsCancelled = await dataSource.query<
        { aggregateid: string; payload: Buffer; tracecontext: string | null }[]
      >(
        `SELECT aggregateid, payload, tracecontext FROM outbox_event
          WHERE type = 'ticketing.seat.cancelled.v1'`,
      );
      expect(seatsCancelled).toHaveLength(seats.length);
      for (const { aggregateid, payload, tracecontext } of seatsCancelled) {
        expect(aggregateid).toBe(DATE_ID);
        expect(tracecontext).toBe(TRACEPARENT);
        const event = fromBinary(SeatCancelledSchema, payload);
        expect(event).toMatchObject({
          dateId: DATE_ID,
          accountId: ACCOUNT,
          reason: WireSeatCancelReason.DATE_CANCELLED,
        });
      }
      expect(await countersOf(DATE_ID)).toEqual(countersBefore);
    },
    SETTLE_MS,
  );

  it(
    "is refunded by the worker's queue: the orders and seats refunded, one order.refunded each",
    async () => {
      const relay = new OwedCallRelay(dataSource, app.get(ProviderCallProducer), clock, SHORT);
      await until(
        'every date refund made',
        async () => {
          await relay.relayDue();
          const [left] = await dataSource.query<{ left: number }[]>(
            `SELECT count(*)::int AS left FROM order_refund
              WHERE reason = $1 AND refunded_at IS NULL`,
            [RefundReason.DATE_CANCELLED],
          );
          return left?.left === 0;
        },
        DRAIN_MS - 10_000,
      );

      const states = await dataSource.query<{ state: string; orders: number }[]>(
        'SELECT state, count(*)::int AS orders FROM seat_order WHERE date_id = $1 GROUP BY state',
        [DATE_ID],
      );
      expect(states).toEqual([{ state: OrderState.REFUNDED, orders: ORDERS }]);
      const seatStates = await dataSource.query<{ state: string }[]>(
        'SELECT DISTINCT state FROM seat WHERE date_id = $1',
        [DATE_ID],
      );
      expect(seatStates).toEqual([{ state: SeatState.REFUNDED }]);
      const refunded = await dataSource.query<{ aggregateid: string; payload: Buffer }[]>(
        `SELECT aggregateid, payload FROM outbox_event WHERE type = 'ticketing.order.refunded.v1'`,
      );
      expect(new Set(refunded.map(({ aggregateid }) => aggregateid)).size).toBe(ORDERS);
      expect(refunded).toHaveLength(ORDERS);
      for (const { payload } of refunded) {
        expect(fromBinary(OrderRefundedSchema, payload)).toMatchObject({
          reason: WireSeatCancelReason.DATE_CANCELLED,
          refundReason: WireRefundReason.DATE_CANCELLED,
        });
      }
      expect(fake.refundsMade).toBe(ORDERS);
    },
    DRAIN_MS,
  );
});
