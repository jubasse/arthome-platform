import { OrderPaidSchema, SeatActivatedSchema } from '@arthome-platform/events';
import { RefusalException, domainRefusal } from '@arthome-platform/http-edge';
import { OutboxEvent } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { CommandBus, CqrsModule, EventBus, QueryBus, type IEvent } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ApiErrorCode,
  FailureNature,
  FixedClock,
  OrderErrorCode,
  OrderState,
  PriceTier,
  SeatHoldState,
  isDomainError,
  isSeatCode,
  plusMinutes,
  plusSeconds,
} from '@arthome/core';

import { GetOrderHandler } from './get-order.handler.js';
import { GetOrder } from './get-order.query.js';
import type { PaymentHandoffView, PurchasedSeats } from './order-views.js';
import { PurchaseStatus, type PurchaseAnswer } from './purchase-seat.command.js';
import { PurchaseSeatHandler } from './purchase-seat.handler.js';
import { QuoteSeatHandler } from './quote-seat.handler.js';
import { QuoteSeat } from './quote-seat.query.js';
import { SeatOrderPaid } from './seat-order.events.js';
import { CLOCK } from '../clock.js';
import { ApplyCatalogDateFactHandler } from '../date-sales/apply-catalog-date-fact.handler.js';
import { OpenCapacityTierHandler } from '../date-sales/open-capacity-tier.handler.js';
import { SetDatePricesHandler } from '../date-sales/set-date-prices.handler.js';
import { nextKey, purchaseOf, putOnSale, ITEST_BUYER_ACCOUNT_ID } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import {
  FakePaymentProvider,
  FakePaymentScenario,
  intentRefOf,
} from '../payments/fake-payment-provider.js';
import { NextActionKind } from '../payments/next-action.js';
import { OwedRefunds } from '../payments/owed-refunds.js';
import { PAYMENT_PORT } from '../payments/payment-tokens.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * adr-ticketing.md §2 against a real Postgres, through the real buses, the fake provider playing
 *   each outcome: what each purchase leaves in `date_sales`, the hold, the order, its seats and the
 *   outbox, and what a replay under its key answers.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const NOW = '2026-09-28T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const CHANNEL = '01a0fb0c-0000-7000-8000-000000000001';
const ORIGIN = 'http://storefront.test';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

let stack: StartedStack;
let dataSource: DataSource;
let cqrs: TestingModule;
let commands: CommandBus;
let queries: QueryBus;
let fake: FakePaymentProvider;
let clock: FixedClock;
let published: IEvent[] = [];
let dates = 0;

async function dateOnSale(capacity = 10, startsAt = STARTS_AT): Promise<string> {
  dates += 1;
  const dateId = `01a0fb00-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await putOnSale(commands, { dateId, channelId: CHANNEL, capacity, startsAt }, NOW);
  return dateId;
}

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

async function ordersOf(dateId: string): Promise<{ id: string; state: string }[]> {
  return dataSource.query('SELECT id, state FROM seat_order WHERE date_id = $1 ORDER BY id', [
    dateId,
  ]);
}

async function holdsOf(dateId: string): Promise<{ state: string; expires_at: Date }[]> {
  return dataSource.query(
    'SELECT state, expires_at FROM seat_hold WHERE date_id = $1 ORDER BY created_at, id',
    [dateId],
  );
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

function purchase(...args: Parameters<typeof purchaseOf>): Promise<PurchaseAnswer> {
  return commands.execute(purchaseOf(...args));
}

function seatsOf(answer: PurchaseAnswer): PurchasedSeats {
  return answer.response.envelope.data as PurchasedSeats;
}

function handoffIn(answer: PurchaseAnswer): PaymentHandoffView {
  return answer.response.envelope.data as PaymentHandoffView;
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_purchase_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock(NOW);
  fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  cqrs = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      TicketingTransactions,
      ApplyCatalogDateFactHandler,
      OpenCapacityTierHandler,
      SetDatePricesHandler,
      PurchaseSeatHandler,
      QuoteSeatHandler,
      GetOrderHandler,
      { provide: DataSource, useValue: dataSource },
      { provide: CLOCK, useValue: clock },
      OwedRefunds,
      { provide: PAYMENT_PORT, useValue: fake },
      { provide: PUBLIC_WEB_ORIGIN, useValue: ORIGIN },
    ],
  }).compile();
  await cqrs.init();
  commands = cqrs.get(CommandBus);
  queries = cqrs.get(QueryBus);
  cqrs.get(EventBus).subscribe((event: IEvent) => published.push(event));
}, STARTUP_MS);

beforeEach(() => {
  fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
  fake.down = false;
  published = [];
});

afterAll(async () => {
  await cqrs?.close();
  await dataSource?.destroy();
  await stack?.stop();
});

describe('a purchase the provider confirms at once', () => {
  it(
    'answers 201 with the seats, consumes the hold, and sells the seats it held',
    async () => {
      const dateId = await dateOnSale();
      const before = await countersOf(dateId);

      const answer = await purchase(dateId, 2, nextKey(), {}, TRACEPARENT);

      expect(answer.status).toBe(PurchaseStatus.PAID);
      expect(answer.response.replayed).toBe(false);
      const { tickets, order } = seatsOf(answer);
      expect(order).toMatchObject({
        state: OrderState.PAID,
        total: { amountMinor: 4800, currencyCode: 'EUR' },
        placedAt: NOW,
      });
      expect(order.reference).toMatch(/^ATH-2026-\d{5}$/);
      expect(tickets).toHaveLength(2);
      for (const ticket of tickets) {
        expect(isSeatCode(ticket.seatCode)).toBe(true);
        expect(ticket).toMatchObject({
          dateId,
          orderId: order.id,
          tier: PriceTier.FULL,
          cancelDeadline: plusMinutes(STARTS_AT, -60),
        });
      }
      expect(await countersOf(dateId)).toEqual({
        seats_available: before.seats_available - 2,
        seats_sold: 2,
        availability_moves: String(Number(before.availability_moves) + 2),
      });
      expect((await holdsOf(dateId)).map(({ state }) => state)).toEqual([SeatHoldState.CONSUMED]);
      expect(fake.calls.filter((call) => call.endsWith(order.id))).toEqual([
        `createIntent ${order.id}`,
      ]);
    },
    CASE_MS,
  );

  it(
    'writes order.paid keyed by the order, then one seat.activated per seat keyed by the date',
    async () => {
      const dateId = await dateOnSale();

      const { tickets, order } = seatsOf(await purchase(dateId, 2, nextKey(), {}, TRACEPARENT));

      const rows = await dataSource.getRepository(OutboxEvent).find({
        where: [
          { aggregateid: order.id },
          { aggregateid: dateId, type: 'ticketing.seat.activated.v1' },
        ],
        order: { id: 'ASC' },
      });
      expect(rows.map(({ aggregatetype, type }) => [aggregatetype, type])).toEqual([
        ['ticketing.order', 'ticketing.order.paid.v1'],
        ['ticketing.date_sales', 'ticketing.seat.activated.v1'],
        ['ticketing.date_sales', 'ticketing.seat.activated.v1'],
      ]);
      expect(rows.every(({ tracecontext }) => tracecontext === TRACEPARENT)).toBe(true);
      const [paidRow, ...seatRows] = rows;
      const paid = fromBinary(OrderPaidSchema, paidRow?.payload ?? new Uint8Array());
      expect(paid).toMatchObject({
        orderId: order.id,
        dateId,
        channelId: CHANNEL,
        grossTtc: { amountMinor: 4800n, currencyCode: 'EUR' },
        paymentIntentRef: intentRefOf(order.id),
      });
      const activated = seatRows.map(({ payload }) => fromBinary(SeatActivatedSchema, payload));
      expect(activated.map(({ seatCode }) => seatCode).sort()).toEqual(
        tickets.map(({ seatCode }) => seatCode).sort(),
      );
      expect(activated[0]?.cancelDeadline && timestampDate(activated[0].cancelDeadline)).toEqual(
        new Date(plusMinutes(STARTS_AT, -60)),
      );
    },
    CASE_MS,
  );

  it(
    'publishes its domain events after the commit, the payment among them',
    async () => {
      const dateId = await dateOnSale();

      await purchase(dateId, 1);

      const paid = published.find(
        (event): event is SeatOrderPaid => event instanceof SeatOrderPaid,
      );
      expect(paid?.dateId).toBe(dateId);
      expect(published.map((event) => (event as { kind: string }).kind)).toEqual(
        expect.arrayContaining([
          'SeatsHeld',
          'SeatHoldPlaced',
          'SeatOrderPlaced',
          'SeatHoldConsumed',
        ]),
      );
    },
    CASE_MS,
  );
});

describe('the key is bound to the order (adr-ticketing.md §2)', () => {
  it(
    'replays the first answer byte for byte, and never asks the provider again',
    async () => {
      const dateId = await dateOnSale();
      const key = nextKey();
      const first = await purchase(dateId, 2, key);
      const calls = fake.calls.length;

      const replay = await purchase(dateId, 2, key);

      expect(replay.status).toBe(PurchaseStatus.PAID);
      expect(replay.response.replayed).toBe(true);
      expect(replay.response.envelope).toEqual(first.response.envelope);
      expect(fake.calls).toHaveLength(calls);
      expect(await ordersOf(dateId)).toHaveLength(1);
      expect((await countersOf(dateId)).seats_sold).toBe(2);
    },
    CASE_MS,
  );

  it(
    'refuses the key with another body, and binds nothing for a purchase it refused',
    async () => {
      const dateId = await dateOnSale(3);
      const key = nextKey();
      await purchase(dateId, 2, key);

      const reused = await refusalOf(purchase(dateId, 1, key));
      expect(reused.refusal.code).toBe(ApiErrorCode.IDEMPOTENCY_KEY_REUSED);

      const refusedKey = nextKey();
      expect((await refusalOf(purchase(dateId, 2, refusedKey))).refusal.code).toBe(
        OrderErrorCode.SOLD_OUT,
      );
      expect((await purchase(dateId, 1, refusedKey)).status).toBe(PurchaseStatus.PAID);
    },
    CASE_MS,
  );

  it(
    'serves one order to two attempts sent at once under one key',
    async () => {
      const dateId = await dateOnSale();
      const key = nextKey();

      const [first, second] = await Promise.all([
        purchase(dateId, 2, key),
        purchase(dateId, 2, key),
      ]);

      expect(first.response.envelope).toEqual(second.response.envelope);
      expect(await ordersOf(dateId)).toHaveLength(1);
      expect(await countersOf(dateId)).toMatchObject({ seats_available: 8, seats_sold: 2 });
    },
    CASE_MS,
  );

  it(
    'resumes an order left between its two transactions, under the intent the provider kept',
    async () => {
      const dateId = await dateOnSale();
      const key = nextKey();
      fake.scenarioOf = () => {
        throw new Error('the process died before tx B');
      };
      await expect(purchase(dateId, 2, key)).rejects.toThrow(/before tx B/);
      const [pending] = await ordersOf(dateId);
      expect(pending?.state).toBe(OrderState.PENDING);
      expect((await holdsOf(dateId)).map(({ state }) => state)).toEqual([SeatHoldState.ACTIVE]);

      fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
      const resumed = await purchase(dateId, 2, key);

      expect(resumed.status).toBe(PurchaseStatus.PAID);
      expect(resumed.response.replayed).toBe(false);
      expect(seatsOf(resumed).order.id).toBe(pending?.id);
      expect(await countersOf(dateId)).toMatchObject({ seats_available: 8, seats_sold: 2 });
    },
    CASE_MS,
  );
});

describe('a purchase the tx A refuses', () => {
  it(
    'refuses a stale price with both amounts, and writes nothing',
    async () => {
      const dateId = await dateOnSale();
      const before = await countersOf(dateId);

      const stale = await refusalOf(
        purchase(dateId, 2, nextKey(), {
          expectedTotal: { amountMinor: 4000, currencyCode: 'EUR' },
        }),
      );

      expect(stale.getStatus()).toBe(409);
      expect(stale.refusal).toEqual({
        code: OrderErrorCode.PRICE_STALE,
        params: { expectedAmountMinor: 4000, currentAmountMinor: 4800, currencyCode: 'EUR' },
        nature: FailureNature.REFUSED,
      });
      const inactive = await refusalOf(purchase(dateId, 1, nextKey(), { tier: PriceTier.REDUCED }));
      expect(inactive.refusal.params).toEqual({ expectedAmountMinor: 2400, currencyCode: 'EUR' });
      expect(await countersOf(dateId)).toEqual(before);
      expect(await ordersOf(dateId)).toEqual([]);
    },
    CASE_MS,
  );

  it(
    'answers sold out past the seats left, and on a date not on sale',
    async () => {
      const dateId = await dateOnSale(3);
      await purchase(dateId, 2);

      expect((await refusalOf(purchase(dateId, 2))).refusal.code).toBe(OrderErrorCode.SOLD_OUT);
      expect(await countersOf(dateId)).toMatchObject({ seats_available: 1, seats_sold: 2 });

      const unknown = '01a0fbee-0000-7000-8000-000000000001';
      expect((await refusalOf(purchase(unknown, 1))).refusal.code).toBe(OrderErrorCode.SOLD_OUT);
    },
    CASE_MS,
  );
});

describe('a purchase that waits for the buyer', () => {
  it(
    'answers 202 with the handoff, which expires with the hold, and replays it',
    async () => {
      const dateId = await dateOnSale();
      fake.scenarioOf = () => FakePaymentScenario.REQUIRE_ACTION;
      const key = nextKey();

      const answer = await purchase(dateId, 2, key);

      expect(answer.status).toBe(PurchaseStatus.AWAITING_PAYMENT);
      const handoff = handoffIn(answer);
      const expiresAt = plusMinutes(NOW, 15);
      expect(handoff).toEqual({
        orderId: handoff.orderId,
        state: OrderState.AWAITING_ACTION,
        paymentIntentRef: intentRefOf(handoff.orderId),
        clientSecret: `${intentRefOf(handoff.orderId)}_secret`,
        nextAction: {
          kind: NextActionKind.REDIRECT_TO_URL,
          redirectUrl: `https://payments.fake.invalid/authenticate/${intentRefOf(handoff.orderId)}`,
        },
        returnUrl: `${ORIGIN}/orders/${handoff.orderId}`,
        expiresAt,
      });
      expect(await holdsOf(dateId)).toEqual([
        { state: SeatHoldState.ACTIVE, expires_at: new Date(expiresAt) },
      ]);
      expect(await countersOf(dateId)).toMatchObject({ seats_available: 8, seats_sold: 0 });

      const replay = await purchase(dateId, 2, key);
      expect(replay.response).toMatchObject({ replayed: true, envelope: answer.response.envelope });

      const detail = await queries.execute(new GetOrder(handoff.orderId, ITEST_BUYER_ACCOUNT_ID));
      expect(detail).toMatchObject({
        order: { id: handoff.orderId, state: OrderState.AWAITING_ACTION },
        tickets: [],
        handoff,
      });
    },
    CASE_MS,
  );
});

describe('a purchase the provider declines', () => {
  it(
    'answers the decline and its code, gives the seats back, and answers it again on replay',
    async () => {
      const dateId = await dateOnSale();
      fake.scenarioOf = () => FakePaymentScenario.DECLINE;
      const key = nextKey();
      const before = await countersOf(dateId);

      const declined = await refusalOf(purchase(dateId, 2, key));

      expect(declined.getStatus()).toBe(409);
      expect(declined.refusal).toMatchObject({
        code: OrderErrorCode.PAYMENT_DECLINED,
        params: { declineCode: 'card_declined' },
      });
      expect(await countersOf(dateId)).toEqual({
        seats_available: before.seats_available,
        seats_sold: 0,
        availability_moves: String(Number(before.availability_moves) + 2),
      });
      expect((await holdsOf(dateId)).map(({ state }) => state)).toEqual([SeatHoldState.RELEASED]);
      expect((await ordersOf(dateId)).map(({ state }) => state)).toEqual([OrderState.FAILED]);

      fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
      expect((await refusalOf(purchase(dateId, 2, key))).refusal.code).toBe(
        OrderErrorCode.PAYMENT_DECLINED,
      );
    },
    CASE_MS,
  );
});

describe('a provider that does not answer (adr-ticketing.md §12)', () => {
  it(
    'answers 503 and gives the hold back; retried under the key, the order resumes and holds again',
    async () => {
      const dateId = await dateOnSale();
      fake.scenarioOf = () => FakePaymentScenario.UNAVAILABLE;
      const key = nextKey();

      const unavailable = await refusalOf(purchase(dateId, 2, key));

      expect(unavailable.getStatus()).toBe(503);
      expect(unavailable.refusal.code).toBe(ApiErrorCode.SERVICE_UNAVAILABLE);
      expect(await countersOf(dateId)).toMatchObject({ seats_available: 10, seats_sold: 0 });
      expect((await ordersOf(dateId)).map(({ state }) => state)).toEqual([OrderState.PENDING]);

      fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
      const resumed = await purchase(dateId, 2, key);

      expect(resumed.status).toBe(PurchaseStatus.PAID);
      const orderId = seatsOf(resumed).order.id;
      expect(fake.calls.filter((call) => call === `createIntent ${orderId}`)).toHaveLength(2);
      expect((await holdsOf(dateId)).map(({ state }) => state)).toEqual([
        SeatHoldState.RELEASED,
        SeatHoldState.CONSUMED,
      ]);
      expect(await countersOf(dateId)).toMatchObject({ seats_available: 8, seats_sold: 2 });
    },
    CASE_MS,
  );

  it(
    'renews its hold with the date row locked for the commit alone, as tx A does',
    async () => {
      const dateId = await dateOnSale();
      const key = nextKey();
      fake.scenarioOf = () => FakePaymentScenario.UNAVAILABLE;
      expect((await refusalOf(purchase(dateId, 2, key))).getStatus()).toBe(503);
      fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
      await dataSource.query(`
        CREATE FUNCTION slow_hold_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(1); RETURN NULL; END $$`);
      await dataSource.query(`
        CREATE TRIGGER slow_hold_insert BEFORE INSERT ON seat_hold
        FOR EACH STATEMENT EXECUTE FUNCTION slow_hold_insert()`);
      try {
        const resuming = purchase(dateId, 2, key);
        const deadline = Date.now() + 5_000;
        let sleeping = 0;
        while (sleeping === 0 && Date.now() < deadline) {
          const [row] = await dataSource.query<{ sleeping: number }[]>(
            `SELECT count(*)::int AS sleeping FROM pg_stat_activity
              WHERE wait_event = 'PgSleep' AND datname = current_database()`,
          );
          sleeping = row?.sleeping ?? 0;
        }
        expect(sleeping).toBe(1);

        // Another buyer's decrement while the renewed hold is being inserted.
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

        expect(waited).toBeNull();
        expect((await resuming).status).toBe(PurchaseStatus.PAID);
      } finally {
        await dataSource.query('DROP TRIGGER slow_hold_insert ON seat_hold');
        await dataSource.query('DROP FUNCTION slow_hold_insert()');
      }
    },
    CASE_MS,
  );

  it(
    'finding no seat to hold again, rolls its renewal back and fails sold out for good',
    async () => {
      const dateId = await dateOnSale(2);
      const key = nextKey();
      fake.scenarioOf = () => FakePaymentScenario.UNAVAILABLE;
      expect((await refusalOf(purchase(dateId, 2, key))).getStatus()).toBe(503);
      fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
      expect((await purchase(dateId, 2, nextKey())).status).toBe(PurchaseStatus.PAID);
      const calls = fake.calls.length;

      const resumed = await refusalOf(purchase(dateId, 2, key));
      const again = await refusalOf(purchase(dateId, 2, key));

      expect([resumed.refusal.code, again.refusal.code]).toEqual([
        OrderErrorCode.SOLD_OUT,
        OrderErrorCode.SOLD_OUT,
      ]);
      expect(fake.calls).toHaveLength(calls);
      expect((await holdsOf(dateId)).map(({ state }) => state)).toEqual([
        SeatHoldState.RELEASED,
        SeatHoldState.CONSUMED,
      ]);
      expect((await ordersOf(dateId)).map(({ state }) => state).sort()).toEqual([
        OrderState.FAILED,
        OrderState.PAID,
      ]);
      expect(await countersOf(dateId)).toMatchObject({ seats_available: 0, seats_sold: 2 });
    },
    CASE_MS,
  );
});

describe('quoteSeat and getOrder', () => {
  it(
    'quotes a tier through core, valid as long as an availability read',
    async () => {
      const dateId = await dateOnSale();

      const quote = await queries.execute(
        new QuoteSeat(dateId, { tier: PriceTier.FULL, quantity: 3 }),
      );

      expect(quote.data).toEqual({
        lines: [{ kind: 'tier', amount: { amountMinor: 7200, currencyCode: 'EUR' } }],
        total: { amountMinor: 7200, currencyCode: 'EUR' },
        validUntil: plusSeconds(NOW, 60),
      });
      expect(quote.validUntil).toBe(plusSeconds(NOW, 60));
      await expect(
        queries.execute(new QuoteSeat(dateId, { tier: PriceTier.REDUCED, quantity: 1 })),
      ).rejects.toMatchObject({ refusal: { code: ApiErrorCode.NOT_FOUND } });
    },
    CASE_MS,
  );

  it(
    'serves a paid order with its tickets, and 404 for one it does not hold',
    async () => {
      const dateId = await dateOnSale();
      const { tickets, order } = seatsOf(await purchase(dateId, 2));

      expect(await queries.execute(new GetOrder(order.id, ITEST_BUYER_ACCOUNT_ID))).toEqual({
        order,
        tickets,
      });
      await expect(
        queries.execute(
          new GetOrder('01a0fbee-0000-7000-8000-0000000000aa', ITEST_BUYER_ACCOUNT_ID),
        ),
      ).rejects.toMatchObject({ refusal: { code: ApiErrorCode.NOT_FOUND } });
    },
    CASE_MS,
  );
});

describe('a buyer arriving after the start (D-089)', () => {
  it(
    'buys before the start without acknowledging anything, the flag ignored',
    async () => {
      const dateId = await dateOnSale(10, plusMinutes(NOW, 5));

      expect((await purchase(dateId, 1)).status).toBe(PurchaseStatus.PAID);
      expect((await purchase(dateId, 1, nextKey(), {}, null, true)).status).toBe(
        PurchaseStatus.PAID,
      );
    },
    CASE_MS,
  );

  it(
    'is refused after the start without the acknowledgement, told what was missed, and holds nothing',
    async () => {
      const startsAt = plusMinutes(NOW, -10);
      const dateId = await dateOnSale(10, startsAt);
      const before = await countersOf(dateId);

      const unacknowledged = await refusalOf(purchase(dateId, 2));

      expect(unacknowledged.getStatus()).toBe(409);
      expect(unacknowledged.refusal).toEqual({
        code: OrderErrorCode.LATE_ENTRY_UNACKNOWLEDGED,
        params: { startedAt: startsAt, minutesElapsed: 10, salesEndAt: plusMinutes(startsAt, 30) },
        nature: FailureNature.REFUSED,
      });
      expect(await countersOf(dateId)).toEqual(before);
      expect(await holdsOf(dateId)).toEqual([]);
      expect(await ordersOf(dateId)).toEqual([]);

      const acknowledged = await purchase(dateId, 2, nextKey(), {}, null, true);
      expect(acknowledged.status).toBe(PurchaseStatus.PAID);
    },
    CASE_MS,
  );

  it(
    'is refused past thirty minutes after the start, acknowledged or not, holding nothing',
    async () => {
      const dateId = await dateOnSale(10, plusMinutes(NOW, -31));
      const before = await countersOf(dateId);

      const late = await refusalOf(purchase(dateId, 1, nextKey(), {}, null, true));

      expect(late.refusal.code).toBe(OrderErrorCode.SALES_CLOSED);
      expect(await countersOf(dateId)).toEqual(before);
      expect(await holdsOf(dateId)).toEqual([]);
    },
    CASE_MS,
  );

  it(
    'is refused past the cutoff by the hold statement itself, before the sweeper closes the sale',
    async () => {
      const dateId = await dateOnSale(10, plusMinutes(NOW, -31));

      const taken = await cqrs.get(TicketingTransactions).run(async ({ dateSales }) => {
        const sales = await dateSales.findUnlocked(dateId);
        if (sales === null) throw new Error('no sale');
        expect(sales.isOnSale).toBe(true);
        // Decided a minute before the cutoff, as a purchase that reached it just after would be.
        sales.holdSeats(1, plusMinutes(NOW, -2));
        return dateSales.takeSeats(sales, 1, NOW);
      });

      expect(taken).toBe(false);
      expect((await countersOf(dateId)).seats_available).toBe(10);
    },
    CASE_MS,
  );

  it(
    'is quoted with what was missed only once the live started, and nothing past the cutoff',
    async () => {
      const soon = plusSeconds(NOW, 30);
      const upcoming = await dateOnSale(10, soon);
      const before = await queries.execute(
        new QuoteSeat(upcoming, { tier: PriceTier.FULL, quantity: 1 }),
      );
      expect(before.data).not.toHaveProperty('lateEntry');
      expect(before.validUntil).toBe(soon);

      const startsAt = plusMinutes(NOW, -10);
      const started = await dateOnSale(10, startsAt);
      const late = await queries.execute(
        new QuoteSeat(started, { tier: PriceTier.FULL, quantity: 1 }),
      );
      expect(late.data.lateEntry).toEqual({
        startedAt: startsAt,
        minutesElapsed: 10,
        salesEndAt: plusMinutes(startsAt, 30),
      });
      expect(late.validUntil).toBe(plusSeconds(NOW, 60));

      const over = await dateOnSale(10, plusMinutes(NOW, -30));
      await expect(
        queries.execute(new QuoteSeat(over, { tier: PriceTier.FULL, quantity: 1 })),
      ).rejects.toMatchObject({ refusal: { code: OrderErrorCode.SALES_CLOSED } });
    },
    CASE_MS,
  );
});

describe('a purchase resumed after the start (D-089, the acknowledgement in a header)', () => {
  it(
    'is asked to acknowledge like a new one, and resumes once it does',
    async () => {
      const startsAt = plusMinutes(clock.now(), 5);
      const dateId = await dateOnSale(10, startsAt);
      const key = nextKey();
      fake.scenarioOf = () => FakePaymentScenario.UNAVAILABLE;
      expect((await refusalOf(purchase(dateId, 2, key))).getStatus()).toBe(503);
      fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
      clock.advance(10 * 60_000);

      const unacknowledged = await refusalOf(purchase(dateId, 2, key));

      expect(unacknowledged.refusal).toMatchObject({
        code: OrderErrorCode.LATE_ENTRY_UNACKNOWLEDGED,
        params: { startedAt: startsAt, minutesElapsed: 5 },
      });
      expect((await holdsOf(dateId)).map(({ state }) => state)).toEqual([SeatHoldState.RELEASED]);

      const resumed = await purchase(dateId, 2, key, {}, null, true);
      expect(resumed.status).toBe(PurchaseStatus.PAID);
      expect((await ordersOf(dateId)).map(({ state }) => state)).toEqual([OrderState.PAID]);
    },
    CASE_MS,
  );

  it(
    'is refused order.sales_closed past the cutoff, before it is asked anything, and for good',
    async () => {
      const startsAt = plusMinutes(clock.now(), -25);
      const dateId = await dateOnSale(10, startsAt);
      const key = nextKey();
      fake.scenarioOf = () => FakePaymentScenario.UNAVAILABLE;
      expect((await refusalOf(purchase(dateId, 2, key, {}, null, true))).getStatus()).toBe(503);
      fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
      clock.advance(10 * 60_000);
      const before = await countersOf(dateId);

      const unacknowledged = await refusalOf(purchase(dateId, 2, key));
      const acknowledged = await refusalOf(purchase(dateId, 2, key, {}, null, true));

      const closed = {
        code: OrderErrorCode.SALES_CLOSED,
        params: { salesEndAt: plusMinutes(startsAt, 30) },
      };
      expect(unacknowledged.refusal).toMatchObject(closed);
      expect(acknowledged.refusal).toMatchObject(closed);
      expect(await countersOf(dateId)).toEqual(before);
      expect((await holdsOf(dateId)).map(({ state }) => state)).toEqual([SeatHoldState.RELEASED]);
      expect((await ordersOf(dateId)).map(({ state }) => state)).toEqual([OrderState.FAILED]);
    },
    CASE_MS,
  );
});
