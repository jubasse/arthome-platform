import { setTimeout as delay } from 'node:timers/promises';

import {
  DateOutcome as WireDateOutcome,
  DateSalesAvailabilityChangedSchema,
  OrderRefundedSchema,
  RefundReason as WireRefundReason,
  SeatCancelReason as WireSeatCancelReason,
  SeatCancelledSchema,
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
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ApiErrorCode,
  CreditOrigin,
  FixedClock,
  OrderErrorCode,
  OrderState,
  RefundDelayCode,
  RefundMethod,
  RefundReason,
  SeatCancelReason,
  SeatState,
  Service,
  isDomainError,
  money,
  plusMinutes,
  refundIdempotencyKey,
} from '@arthome/core';

import type { SeatCancellationView } from './cancel-seat.command.js';
import { SeatsModule } from './seats.module.js';
import { AvailabilityPublisher } from '../availability/availability-publisher.js';
import { AvailabilityPublisherModule } from '../availability/availability-publisher.module.js';
import { PublishDueAvailability } from '../availability/publish-due-availability.command.js';
import { CLOCK } from '../clock.js';
import { Credit } from '../credits/credit.aggregate.js';
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
} from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { GetOrder } from '../orders/get-order.query.js';
import type { OrderDetail, PurchasedSeats, TicketView } from '../orders/order-views.js';
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
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * A viewer's `cancelSeat` through the buses, against a real Postgres and a Redis of the file's
 *   own: the share owed, the seat cancelled then refunded by the worker's queue, the seat back on
 *   sale at once and published, the refusals, a cancelled date, and the hot row left free while
 *   the cancellation writes. Its HTTP face is `seats.http.itest.ts`'s.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const PREFIX = '{ticketing-cancel-seat-itest}';
const SHORT: ProviderCallSchedules = { refunds: [100, 200], intentCancellations: [100] };
const NOW = '2026-10-06T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const CHANNEL = '01a0f80c-0000-7000-8000-000000000001';
const OTHER_ACCOUNT_ID = '019a0000-0000-7000-8000-00000000c0c0';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let clock: FixedClock;
let fake: FakePaymentProvider;
let relay: OwedCallRelay;
let dates = 0;

const commands = (): CommandBus => app.get(CommandBus);

async function dateOnSale(capacity: number, startsAt = STARTS_AT): Promise<string> {
  dates += 1;
  const dateId = `01a0f800-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await putOnSale(commands(), { dateId, channelId: CHANNEL, capacity, startsAt }, clock.now());
  return dateId;
}

/** Bought and paid at once, the fake confirming: its seats in the order every read serves them. */
async function bought(dateId: string, quantity: number): Promise<PurchasedSeats> {
  const answer: PurchaseAnswer = await commands().execute(purchaseOf(dateId, quantity));
  return answer.response.envelope.data as PurchasedSeats;
}

function cancel(
  seatId: string,
  key?: string,
  accountId?: string,
): Promise<MemorisedResponse<SeatCancellationView>> {
  return commands().execute(seatCancellationOf(seatId, key, accountId, TRACEPARENT));
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

const ticketOf = (answer: MemorisedResponse<SeatCancellationView>): TicketView =>
  answer.envelope.data.ticket;

interface Counters {
  readonly seats_available: number;
  readonly seats_sold: number;
  readonly availability_moves: string;
}

async function countersOf(dateId: string): Promise<Counters> {
  const [row] = await dataSource.query<Counters[]>(
    'SELECT seats_available, seats_sold, availability_moves FROM date_sales WHERE date_id = $1',
    [dateId],
  );
  if (row === undefined) throw new Error(`no date ${dateId}`);
  return row;
}

interface RefundRow {
  readonly id: string;
  readonly seat_id: string | null;
  readonly amount_minor: string;
  readonly reason: string;
  readonly idempotency_key: string;
  readonly traceparent: string | null;
  readonly refunded_at: Date | null;
}

function refundsOf(orderId: string): Promise<RefundRow[]> {
  return dataSource.query(
    `SELECT id, seat_id, amount_minor, reason, idempotency_key, traceparent, refunded_at
       FROM order_refund WHERE order_id = $1 ORDER BY owed_at, id`,
    [orderId],
  );
}

async function seatRowOf(seatId: string) {
  const [row] = await dataSource.query<
    {
      state: string;
      ended_at: Date | null;
      cancel_reason: string | null;
      refund_id: string | null;
      refund_amount_minor: string | null;
    }[]
  >(
    `SELECT state, ended_at, cancel_reason, refund_id, refund_amount_minor
       FROM seat WHERE id = $1`,
    [seatId],
  );
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

async function outboxOf(aggregateId: string, type: string): Promise<OutboxEvent[]> {
  return dataSource.getRepository(OutboxEvent).find({
    where: { aggregateid: aggregateId, type },
    order: { created_at: 'ASC', id: 'ASC' },
  });
}

async function seatsCancelledOn(dateId: string) {
  return (await outboxOf(dateId, 'ticketing.seat.cancelled.v1')).map((row) => ({
    row,
    event: fromBinary(SeatCancelledSchema, row.payload),
  }));
}

async function ordersRefunded(orderId: string) {
  return (await outboxOf(orderId, 'ticketing.order.refunded.v1')).map((row) =>
    fromBinary(OrderRefundedSchema, row.payload),
  );
}

async function availabilityPublished(dateId: string) {
  return (await outboxOf(dateId, 'ticketing.date_sales.availability_changed.v1')).map((row) => {
    const event = fromBinary(DateSalesAvailabilityChangedSchema, row.payload);
    return [event.seatsAvailable, event.soldOut];
  });
}

async function until(what: string, ready: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await ready())) {
    if (performance.now() > deadline) throw new Error(`${what}, not within ${timeoutMs} ms`);
    await delay(50);
  }
}

/** The worker process's relay pass, then the refund queue's job, both as the worker runs them. */
async function refundsMadeFor(orderId: string): Promise<void> {
  await relay.relayDue();
  await until('the refunds made', async () =>
    (await refundsOf(orderId)).every(({ refunded_at }) => refunded_at !== null),
  );
}

async function cancelDate(dateId: string): Promise<void> {
  const applied = await applyCatalogDateMessage(
    commands(),
    delivered(outcomeDeclared(dateId, WireDateOutcome.CANCELLED, clock.now())),
  );
  expect(applied).toBe(Outcome.APPLIED);
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, redis: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_cancel_seat_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock(NOW);
  fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  app = await httpApp({
    imports: [
      OrdersModule,
      SeatsModule,
      DateSalesModule,
      CatalogFactsModule,
      AvailabilityPublisherModule,
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
      [AvailabilityPublisher, {}],
    ],
  });
  relay = new OwedCallRelay(dataSource, app.get(ProviderCallProducer), clock, SHORT);
}, STARTUP_MS);

afterAll(async () => {
  await app?.close();
  await stack?.stop();
});

describe('cancelSeat', () => {
  it(
    'cancels one seat of three: its share owed under its own key, the seat back on sale at once',
    async () => {
      const dateId = await dateOnSale(3);
      const { order, tickets } = await bought(dateId, 3);
      await commands().execute(new PublishDueAvailability());
      const before = await countersOf(dateId);
      const seatId = tickets[1]?.seatId ?? '';
      clock.advance(1_000);

      const answer = await cancel(seatId);

      expect(answer.replayed).toBe(false);
      expect(ticketOf(answer)).toEqual({
        seatId,
        dateId,
        orderId: order.id,
        seatCode: tickets[1]?.seatCode,
        tier: tickets[1]?.tier,
        state: SeatState.CANCELLED,
        cancelDeadline: plusMinutes(STARTS_AT, -60),
        refund: {
          amount: money(2400, 'EUR'),
          delayCode: RefundDelayCode.BUSINESS_DAYS_3_5,
          method: RefundMethod.ORIGINAL_PAYMENT_METHOD,
          refundReasonCode: RefundReason.VIEWER_REQUEST,
        },
      });
      const [refund, ...others] = await refundsOf(order.id);
      expect(others).toEqual([]);
      expect(refund).toMatchObject({
        seat_id: seatId,
        amount_minor: '2400',
        reason: RefundReason.VIEWER_REQUEST,
        idempotency_key: refundIdempotencyKey(refund?.id ?? ''),
        traceparent: TRACEPARENT,
        refunded_at: null,
      });
      expect(await seatRowOf(seatId)).toEqual({
        state: SeatState.CANCELLED,
        ended_at: new Date(clock.now()),
        cancel_reason: SeatCancelReason.VIEWER_REQUEST,
        refund_id: refund?.id,
        refund_amount_minor: '2400',
      });
      const [cancelled, ...more] = await seatsCancelledOn(dateId);
      expect(more).toEqual([]);
      expect(cancelled?.event).toMatchObject({
        seatId,
        dateId,
        accountId: ITEST_BUYER_ACCOUNT_ID,
        reason: WireSeatCancelReason.VIEWER_REQUEST,
      });
      expect(cancelled?.row).toMatchObject({
        aggregatetype: 'ticketing.date_sales',
        tracecontext: TRACEPARENT,
      });
      expect(await countersOf(dateId)).toEqual({
        seats_available: 1,
        seats_sold: 2,
        availability_moves: String(Number(before.availability_moves) + 1),
      });
      expect(fake.calls.filter((call) => call.startsWith('refund'))).toEqual([]);

      await commands().execute(new PublishDueAvailability());
      expect((await availabilityPublished(dateId)).slice(-2)).toEqual([
        [0, true],
        [1, false],
      ]);
    },
    CASE_MS,
  );

  it(
    'has the worker refund it, partially then wholly, with order.refunded for each',
    async () => {
      const dateId = await dateOnSale(3);
      const { order, tickets } = await bought(dateId, 3);
      const [first, second, third] = tickets.map(({ seatId }) => seatId) as [
        string,
        string,
        string,
      ];

      await cancel(first);
      await refundsMadeFor(order.id);

      expect((await seatRowOf(first)).state).toBe(SeatState.REFUNDED);
      expect(await orderStateOf(order.id)).toBe(OrderState.PARTIALLY_REFUNDED);
      expect(await ordersRefunded(order.id)).toMatchObject([
        {
          amount: { amountMinor: 2400n, currencyCode: 'EUR' },
          reason: WireSeatCancelReason.VIEWER_REQUEST,
          refundReason: WireRefundReason.VIEWER_REQUEST,
        },
      ]);
      const partial: OrderDetail = await app
        .get(QueryBus)
        .execute(new GetOrder(order.id, ITEST_BUYER_ACCOUNT_ID));
      expect(partial.order).toMatchObject({
        state: OrderState.PARTIALLY_REFUNDED,
        refundReasonCode: RefundReason.VIEWER_REQUEST,
      });
      expect(partial.tickets.find(({ seatId }) => seatId === first)).toMatchObject({
        state: SeatState.REFUNDED,
        refund: { amount: money(2400, 'EUR'), refundReasonCode: RefundReason.VIEWER_REQUEST },
      });
      expect(partial.tickets.find(({ seatId }) => seatId === second)?.refund).toBeNull();

      await cancel(second);
      await cancel(third);
      await refundsMadeFor(order.id);

      expect(await orderStateOf(order.id)).toBe(OrderState.REFUNDED);
      expect((await ordersRefunded(order.id)).map(({ reason }) => reason)).toEqual([
        WireSeatCancelReason.VIEWER_REQUEST,
        WireSeatCancelReason.VIEWER_REQUEST,
        WireSeatCancelReason.VIEWER_REQUEST,
      ]);
      expect(await countersOf(dateId)).toMatchObject({ seats_available: 3, seats_sold: 0 });
    },
    CASE_MS,
  );

  it(
    'replays its answer byte for byte under its key, and refuses the key for another seat',
    async () => {
      const dateId = await dateOnSale(3);
      const { order, tickets } = await bought(dateId, 2);
      const key = nextKey();

      const first = await cancel(tickets[0]?.seatId ?? '', key);
      clock.advance(1_000);
      const replay = await cancel(tickets[0]?.seatId ?? '', key);

      expect(replay.replayed).toBe(true);
      expect(JSON.stringify(replay.envelope)).toBe(JSON.stringify(first.envelope));
      expect(await refundsOf(order.id)).toHaveLength(1);
      expect(await seatsCancelledOn(dateId)).toHaveLength(1);
      expect((await countersOf(dateId)).seats_sold).toBe(1);

      const reused = await refusalOf(cancel(tickets[1]?.seatId ?? '', key));
      expect(reused.refusal.code).toBe(ApiErrorCode.IDEMPOTENCY_KEY_REUSED);
      expect((await seatRowOf(tickets[1]?.seatId ?? '')).state).toBe(SeatState.ACTIVE);
    },
    CASE_MS,
  );

  it(
    'answers 404 for another account’s seat and for a seat it does not hold, moving nothing',
    async () => {
      const dateId = await dateOnSale(3);
      const { order, tickets } = await bought(dateId, 1);
      const seatId = tickets[0]?.seatId ?? '';

      const theirs = await refusalOf(cancel(seatId, nextKey(), OTHER_ACCOUNT_ID));
      const unknown = await refusalOf(cancel('01a0f8ff-0000-7000-8000-000000000001'));

      expect(theirs.getStatus()).toBe(404);
      expect(theirs.refusal.code).toBe(ApiErrorCode.NOT_FOUND);
      expect(unknown.refusal.code).toBe(ApiErrorCode.NOT_FOUND);
      expect((await seatRowOf(seatId)).state).toBe(SeatState.ACTIVE);
      expect(await refundsOf(order.id)).toEqual([]);
    },
    CASE_MS,
  );

  it(
    'refuses a seat past its deadline with the instant, and one already refunded with its state',
    async () => {
      const soon = plusMinutes(clock.now(), 30);
      const late = await dateOnSale(3, soon);
      const { tickets: lateTickets } = await bought(late, 1);

      const passed = await refusalOf(cancel(lateTickets[0]?.seatId ?? ''));
      expect(passed.getStatus()).toBe(409);
      expect(passed.refusal).toMatchObject({
        code: OrderErrorCode.SEAT_CANCEL_DEADLINE_PASSED,
        params: { cancelDeadline: plusMinutes(soon, -60) },
      });

      const dateId = await dateOnSale(3);
      const { order, tickets } = await bought(dateId, 1);
      const seatId = tickets[0]?.seatId ?? '';
      await cancel(seatId);
      await refundsMadeFor(order.id);

      const again = await refusalOf(cancel(seatId));
      expect(again.getStatus()).toBe(409);
      expect(again.refusal).toMatchObject({
        code: OrderErrorCode.SEAT_NOT_ACTIVE,
        params: { state: SeatState.REFUNDED },
      });
      expect(await refundsOf(order.id)).toHaveLength(1);
    },
    CASE_MS,
  );

  it(
    'on a cancelled date: date_cancelled, past the deadline still, and no seat back on sale',
    async () => {
      const soon = plusMinutes(clock.now(), 30);
      const dateId = await dateOnSale(3, soon);
      const { order, tickets } = await bought(dateId, 2);
      const seatId = tickets[0]?.seatId ?? '';
      await cancelDate(dateId);
      const before = await countersOf(dateId);

      const answer = await cancel(seatId);

      expect(ticketOf(answer)).toMatchObject({
        state: SeatState.CANCELLED,
        refund: { amount: money(2400, 'EUR'), refundReasonCode: RefundReason.DATE_CANCELLED },
      });
      expect(await refundsOf(order.id)).toMatchObject([{ reason: RefundReason.DATE_CANCELLED }]);
      expect((await seatRowOf(seatId)).cancel_reason).toBe(SeatCancelReason.DATE_CANCELLED);
      expect((await seatsCancelledOn(dateId)).map(({ event }) => event.reason)).toEqual([
        WireSeatCancelReason.DATE_CANCELLED,
      ]);
      expect(await countersOf(dateId)).toEqual(before);

      await refundsMadeFor(order.id);
      expect(
        (await ordersRefunded(order.id)).map(({ reason, refundReason }) => [reason, refundReason]),
      ).toEqual([[WireSeatCancelReason.DATE_CANCELLED, WireRefundReason.DATE_CANCELLED]]);
    },
    CASE_MS,
  );

  it(
    'cancels a seat of a disputed order with nothing refunded: the provider holds the money',
    async () => {
      const dateId = await dateOnSale(3);
      const { order, tickets } = await bought(dateId, 2);
      await dataSource.query('UPDATE seat_order SET state = $2 WHERE id = $1', [
        order.id,
        OrderState.DISPUTED,
      ]);
      const seatId = tickets[0]?.seatId ?? '';

      const answer = await cancel(seatId);

      expect(ticketOf(answer)).toMatchObject({ state: SeatState.CANCELLED, refund: null });
      expect(await refundsOf(order.id)).toEqual([]);
      expect(await seatRowOf(seatId)).toMatchObject({ refund_id: null, refund_amount_minor: null });
      expect(await orderStateOf(order.id)).toBe(OrderState.DISPUTED);
      expect(await countersOf(dateId)).toMatchObject({ seats_available: 2, seats_sold: 1 });
    },
    CASE_MS,
  );
});

describe('the hot row under a cancellation (adr-ticketing.md §2, §3)', () => {
  it(
    'is not held while the cancellation writes its outbox rows: a hold on the date does not wait',
    async () => {
      const dateId = await dateOnSale(10);
      const { tickets } = await bought(dateId, 1);
      await dataSource.query(`
        CREATE FUNCTION pt2_slow_outbox_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(1); RETURN NULL; END $$`);
      await dataSource.query(`
        CREATE TRIGGER pt2_slow_outbox_insert BEFORE INSERT ON outbox_event
        FOR EACH STATEMENT EXECUTE FUNCTION pt2_slow_outbox_insert()`);
      try {
        const cancelling = cancel(tickets[0]?.seatId ?? '');
        const deadline = performance.now() + 5_000;
        let sleeping = 0;
        while (sleeping === 0 && performance.now() < deadline) {
          const [row] = await dataSource.query<{ sleeping: number }[]>(
            `SELECT count(*)::int AS sleeping FROM pg_stat_activity
              WHERE wait_event = 'PgSleep' AND datname = current_database()`,
          );
          sleeping = row?.sleeping ?? 0;
        }
        expect(sleeping).toBe(1);

        const runner = dataSource.createQueryRunner();
        await runner.connect();
        let waited: unknown = null;
        try {
          await runner.startTransaction();
          await runner.query("SET LOCAL lock_timeout = '200ms'");
          await runner.query(
            `UPDATE date_sales
                SET seats_available = seats_available - 1,
                    availability_moves = availability_moves + 1
              WHERE date_id = $1 AND on_sale AND seats_available >= 1`,
            [dateId],
          );
        } catch (error) {
          waited = error;
        } finally {
          await runner.rollbackTransaction();
          await runner.release();
        }
        await cancelling;

        expect(waited).toBeNull();
        expect(await countersOf(dateId)).toMatchObject({ seats_available: 10, seats_sold: 0 });
      } finally {
        await dataSource.query('DROP TRIGGER pt2_slow_outbox_insert ON outbox_event');
        await dataSource.query('DROP FUNCTION pt2_slow_outbox_insert()');
      }
    },
    CASE_MS,
  );
});

describe('a credited seat, as PT1 credits an interrupted date', () => {
  it(
    'is saved with its credit and its share, a share of nothing included',
    async () => {
      const dateId = await dateOnSale(3);
      const { order, tickets } = await bought(dateId, 2);
      const creditId = '01a0f8cc-0000-7000-8000-000000000001';

      await app.get(TicketingTransactions).run(async ({ orders, credits }) => {
        const loaded = await orders.findById(order.id);
        if (loaded === null) throw new Error(`no order ${order.id}`);
        const { accountId, channelId } = loaded.snapshot;
        if (accountId === null) throw new Error(`order ${order.id} has no account`);
        await credits.issue(
          Credit.issue(
            {
              id: creditId,
              accountId,
              channelId,
              orderId: order.id,
              amount: money(1, 'EUR'),
              origin: CreditOrigin.INTERRUPTED_DATE,
              originRef: dateId,
            },
            clock.now(),
          ),
        );
        loaded.creditSeats(
          {
            creditId,
            seats: [
              { seatId: tickets[0]?.seatId ?? '', creditAmount: money(1, 'EUR') },
              { seatId: tickets[1]?.seatId ?? '', creditAmount: money(0, 'EUR') },
            ],
          },
          clock.now(),
        );
        await orders.save(loaded);
      });

      const credited = await dataSource.query<
        { state: string; credit_id: string; credit_amount_minor: string; ended_at: Date }[]
      >(
        `SELECT state, credit_id, credit_amount_minor, ended_at
           FROM seat WHERE order_id = $1 ORDER BY credit_amount_minor DESC`,
        [order.id],
      );
      expect(credited).toEqual([
        {
          state: SeatState.CREDITED,
          credit_id: creditId,
          credit_amount_minor: '1',
          ended_at: new Date(clock.now()),
        },
        {
          state: SeatState.CREDITED,
          credit_id: creditId,
          credit_amount_minor: '0',
          ended_at: new Date(clock.now()),
        },
      ]);
    },
    CASE_MS,
  );
});
