import { setTimeout as delay } from 'node:timers/promises';

import {
  DateOutcome as WireDateOutcome,
  OrderRefundedSchema,
  RefundReason as WireRefundReason,
  SeatCancelReason as WireSeatCancelReason,
} from '@arthome-platform/events';
import {
  RefusalException,
  domainRefusal,
  type MemorisedResponse,
} from '@arthome-platform/http-edge';
import { Outcome, OutboxEvent } from '@arthome-platform/messaging';
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
  DateOutcome,
  DomainErrorCode,
  FixedClock,
  OrderErrorCode,
  OrderState,
  RefundReason,
  SeatCancelReason,
  SeatState,
  Service,
  isDomainError,
  money,
} from '@arthome/core';

import type { SeatRefundView } from './refund-seat.command.js';
import type { RefundSeatBody } from './refund-seat.schema.js';
import { SeatsModule } from './seats.module.js';
import { CLOCK } from '../clock.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { delivered, outcomeDeclared } from '../itest/catalog-messages.js';
import {
  ITEST_BUYER_ACCOUNT_ID,
  nextKey,
  purchaseOf,
  putOnSale,
  seatCancellationOf,
  seatRefundOf,
} from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import type { PurchasedSeats } from '../orders/order-views.js';
import { OrdersModule } from '../orders/orders.module.js';
import type { PurchaseAnswer } from '../orders/purchase-seat.command.js';
import { FakePaymentProvider } from '../payments/fake-payment-provider.js';
import { OwedCallRelay, ProviderCallProducer } from '../payments/owed-call-relay.js';
import {
  PROVIDER_CALL_SCHEDULES,
  type ProviderCallSchedules,
} from '../payments/provider-call-queues.js';
import { ProviderCallQueuesModule } from '../payments/provider-call-queues.module.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/**
 * The studio's `refundSeat` through the buses, against a real Postgres and a Redis of the file's
 *   own: a refund leaves the seat active unless it is a cancelled date's (D-095, D-097), never past
 *   what is left, refused on a disputed order, made by the worker's queue. Its HTTP face is
 *   `seats.http.itest.ts`'s.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const PREFIX = '{ticketing-refund-seat-itest}';
const SHORT: ProviderCallSchedules = { refunds: [100, 200], intentCancellations: [100] };
const NOW = '2026-10-06T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const CHANNEL = '01a0f90c-0000-7000-8000-000000000001';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let clock: FixedClock;
let fake: FakePaymentProvider;
let relay: OwedCallRelay;
let dates = 0;

const commands = (): CommandBus => app.get(CommandBus);

async function dateOnSale(capacity = 5): Promise<string> {
  dates += 1;
  const dateId = `01a0f900-0000-7000-8000-${String(dates).padStart(12, '0')}`;
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

function refund(
  seatId: string,
  body: RefundSeatBody,
  key?: string,
): Promise<MemorisedResponse<SeatRefundView>> {
  return commands().execute(seatRefundOf(seatId, body, key, TRACEPARENT));
}

async function refusalOf(attempt: Promise<unknown>): Promise<RefusalException> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof RefusalException) return error;
    if (isDomainError(error)) return domainRefusal(error);
    throw error;
  }
  throw new Error('expected a refusal');
}

async function countersOf(dateId: string) {
  const [row] = await dataSource.query<
    { seats_available: number; seats_sold: number; availability_moves: string }[]
  >('SELECT seats_available, seats_sold, availability_moves FROM date_sales WHERE date_id = $1', [
    dateId,
  ]);
  if (row === undefined) throw new Error(`no date ${dateId}`);
  return row;
}

function refundsOf(
  orderId: string,
): Promise<
  { amount_minor: string; reason: string; seat_id: string | null; refunded_at: Date | null }[]
> {
  return dataSource.query(
    `SELECT amount_minor, reason, seat_id, refunded_at
       FROM order_refund WHERE order_id = $1 ORDER BY owed_at, id`,
    [orderId],
  );
}

async function seatOf(seatId: string) {
  const [row] = await dataSource.query<
    { state: string; cancel_reason: string | null; refund_amount_minor: string | null }[]
  >('SELECT state, cancel_reason, refund_amount_minor FROM seat WHERE id = $1', [seatId]);
  if (row === undefined) throw new Error(`no seat ${seatId}`);
  return row;
}

async function orderStateOf(orderId: string): Promise<string> {
  const [row] = await dataSource.query<{ state: string }[]>(
    'SELECT state FROM seat_order WHERE id = $1',
    [orderId],
  );
  if (row === undefined) throw new Error(`no order ${orderId}`);
  return row.state;
}

function outboxOf(aggregateId: string, type: string): Promise<OutboxEvent[]> {
  return dataSource.getRepository(OutboxEvent).find({
    where: { aggregateid: aggregateId, type },
    order: { created_at: 'ASC', id: 'ASC' },
  });
}

async function until(what: string, ready: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await ready())) {
    if (performance.now() > deadline) throw new Error(`${what}, not within ${timeoutMs} ms`);
    await delay(50);
  }
}

async function refundsMadeFor(orderId: string): Promise<void> {
  await relay.relayDue();
  await until('the refunds made', async () =>
    (await refundsOf(orderId)).every(({ refunded_at }) => refunded_at !== null),
  );
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, redis: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_refund_seat_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock(NOW);
  fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  app = await httpApp({
    imports: [
      OrdersModule,
      SeatsModule,
      DateSalesModule,
      CatalogFactsModule,
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
      [OwedCallRelay, {}],
    ],
  });
  relay = new OwedCallRelay(dataSource, app.get(ProviderCallProducer), clock, SHORT);
}, STARTUP_MS);

afterAll(async () => {
  await app?.close();
  await stack?.stop();
});

describe('refundSeat', () => {
  it(
    'refunds goodwill in part and leaves the seat active, the order partially refunded',
    async () => {
      const dateId = await dateOnSale();
      const { order, tickets } = await bought(dateId, 2);
      const seatId = tickets[0]?.seatId ?? '';
      const before = await countersOf(dateId);

      const answer = await refund(seatId, {
        refundReasonCode: RefundReason.GOODWILL,
        partialAmountMinor: 500,
      });

      expect(answer.envelope.data).toEqual({ refunded: money(500, 'EUR'), payoutId: null });
      expect(await refundsOf(order.id)).toMatchObject([
        { amount_minor: '500', reason: RefundReason.GOODWILL, seat_id: seatId },
      ]);
      await refundsMadeFor(order.id);
      expect(await seatOf(seatId)).toMatchObject({ state: SeatState.ACTIVE, cancel_reason: null });
      expect(await orderStateOf(order.id)).toBe(OrderState.PARTIALLY_REFUNDED);
      expect(await outboxOf(dateId, 'ticketing.seat.cancelled.v1')).toEqual([]);
      const [refunded] = (await outboxOf(order.id, 'ticketing.order.refunded.v1')).map((row) =>
        fromBinary(OrderRefundedSchema, row.payload),
      );
      expect(refunded).toMatchObject({
        amount: { amountMinor: 500n },
        reason: WireSeatCancelReason.UNSPECIFIED,
        refundReason: WireRefundReason.GOODWILL,
      });
      expect(await countersOf(dateId)).toEqual(before);

      const viewerAfter = await commands().execute(seatCancellationOf(seatId));
      expect(viewerAfter.envelope.data.ticket.refund).toMatchObject({
        amount: money(2400, 'EUR'),
        refundReasonCode: RefundReason.VIEWER_REQUEST,
      });
    },
    CASE_MS,
  );

  it(
    'refunds a duplicate in full, the seat’s share, and refuses past what is left naming it',
    async () => {
      const dateId = await dateOnSale();
      const { order, tickets } = await bought(dateId, 2);
      const [first, second] = tickets.map(({ seatId }) => seatId) as [string, string];

      const whole = await refund(first, { refundReasonCode: RefundReason.DUPLICATE });
      expect(whole.envelope.data.refunded).toEqual(money(2400, 'EUR'));
      await refund(second, { refundReasonCode: RefundReason.GOODWILL, partialAmountMinor: 2000 });

      const past = await refusalOf(
        refund(second, { refundReasonCode: RefundReason.GOODWILL, partialAmountMinor: 401 }),
      );
      expect(past.getStatus()).toBe(409);
      expect(past.refusal).toMatchObject({
        code: OrderErrorCode.REFUND_AMOUNT_EXCEEDS_REMAINING,
        params: { remainingMinor: 400, currencyCode: 'EUR' },
      });
      await refund(second, { refundReasonCode: RefundReason.GOODWILL });
      const nothingLeft = await refusalOf(
        refund(first, { refundReasonCode: RefundReason.DUPLICATE }),
      );
      expect(nothingLeft.refusal).toMatchObject({
        code: OrderErrorCode.REFUND_AMOUNT_EXCEEDS_REMAINING,
        params: { remainingMinor: 0, currencyCode: 'EUR' },
      });
      expect((await refundsOf(order.id)).map(({ amount_minor }) => amount_minor)).toEqual([
        '2400',
        '2000',
        '400',
      ]);
      await refundsMadeFor(order.id);
      expect(await orderStateOf(order.id)).toBe(OrderState.REFUNDED);
      expect((await seatOf(first)).state).toBe(SeatState.ACTIVE);
    },
    CASE_MS,
  );

  it(
    'refuses date_cancelled on a date no cancellation closed, naming its outcome',
    async () => {
      const dateId = await dateOnSale();
      const { tickets } = await bought(dateId, 1);
      const seatId = tickets[0]?.seatId ?? '';

      const scheduled = await refusalOf(
        refund(seatId, { refundReasonCode: RefundReason.DATE_CANCELLED }),
      );
      expect(scheduled.getStatus()).toBe(409);
      expect(scheduled.refusal.code).toBe(DomainErrorCode.STATE_CONFLICT);
      expect(scheduled.refusal.params).toEqual({ currentVersion: expect.any(Number) as number });

      expect(
        await applyCatalogDateMessage(
          commands(),
          delivered(outcomeDeclared(dateId, WireDateOutcome.INTERRUPTED, clock.now())),
        ),
      ).toBe(Outcome.APPLIED);
      const interrupted = await refusalOf(
        refund(seatId, { refundReasonCode: RefundReason.DATE_CANCELLED }),
      );
      expect(interrupted.refusal).toMatchObject({
        code: DomainErrorCode.STATE_CONFLICT,
        params: { state: DateOutcome.INTERRUPTED },
      });
      expect((await seatOf(seatId)).state).toBe(SeatState.ACTIVE);
    },
    CASE_MS,
  );

  it(
    'cancels the seat on a cancelled date, no seat back on sale, then refunds it',
    async () => {
      const dateId = await dateOnSale();
      const { order, tickets } = await bought(dateId, 2);
      const seatId = tickets[1]?.seatId ?? '';
      expect(
        await applyCatalogDateMessage(
          commands(),
          delivered(outcomeDeclared(dateId, WireDateOutcome.CANCELLED, clock.now())),
        ),
      ).toBe(Outcome.APPLIED);
      const before = await countersOf(dateId);

      await refund(seatId, { refundReasonCode: RefundReason.DATE_CANCELLED });

      expect(await seatOf(seatId)).toEqual({
        state: SeatState.CANCELLED,
        cancel_reason: SeatCancelReason.DATE_CANCELLED,
        refund_amount_minor: '2400',
      });
      expect(await outboxOf(dateId, 'ticketing.seat.cancelled.v1')).toHaveLength(1);
      expect(await countersOf(dateId)).toEqual(before);
      await refundsMadeFor(order.id);
      expect((await seatOf(seatId)).state).toBe(SeatState.REFUNDED);
      expect((await seatOf(tickets[0]?.seatId ?? '')).state).toBe(SeatState.ACTIVE);
    },
    CASE_MS,
  );

  it(
    'refuses a disputed order naming its state, and a seat no longer active naming its own',
    async () => {
      const dateId = await dateOnSale();
      const { order, tickets } = await bought(dateId, 2);
      const [first, second] = tickets.map(({ seatId }) => seatId) as [string, string];
      await commands().execute(seatCancellationOf(first));

      const cancelled = await refusalOf(refund(first, { refundReasonCode: RefundReason.GOODWILL }));
      expect(cancelled.refusal).toMatchObject({
        code: OrderErrorCode.SEAT_NOT_ACTIVE,
        params: { state: SeatState.CANCELLED },
      });

      await dataSource.query('UPDATE seat_order SET state = $2 WHERE id = $1', [
        order.id,
        OrderState.DISPUTED,
      ]);
      const disputed = await refusalOf(refund(second, { refundReasonCode: RefundReason.DISPUTE }));
      expect(disputed.getStatus()).toBe(409);
      expect(disputed.refusal).toMatchObject({
        code: DomainErrorCode.STATE_CONFLICT,
        params: { state: OrderState.DISPUTED },
      });
      expect(await refundsOf(order.id)).toHaveLength(1);
    },
    CASE_MS,
  );

  it(
    'replays its answer under its key, owing the refund once',
    async () => {
      const dateId = await dateOnSale();
      const { order, tickets } = await bought(dateId, 1);
      const seatId = tickets[0]?.seatId ?? '';
      const key = nextKey();
      const body = { refundReasonCode: RefundReason.GOODWILL, partialAmountMinor: 300 };

      const first = await refund(seatId, body, key);
      const replay = await refund(seatId, body, key);

      expect(replay.replayed).toBe(true);
      expect(JSON.stringify(replay.envelope)).toBe(JSON.stringify(first.envelope));
      expect(await refundsOf(order.id)).toHaveLength(1);
    },
    CASE_MS,
  );
});
