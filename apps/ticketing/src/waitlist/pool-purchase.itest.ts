import type { PerishableResponse } from '@arthome-platform/http-edge';
import { startStack, type StartedStack } from '@arthome-platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  HOLD_MINUTES_CHECKOUT,
  OrderErrorCode,
  OrderState,
  PriceTier,
  SeatHoldState,
  WAITLIST_PRIORITY_HOURS,
  plusHours,
  plusMinutes,
  plusSeconds,
  priorityUntilOf,
} from '@arthome/core';

import { EndPriorityWindows } from './end-priority-windows.command.js';
import {
  accountOf,
  buy,
  figuresOf,
  join,
  openTier,
  refusalOf,
  soldOutDate,
  startWaitlistHarness,
  travelTo,
  type Figures,
  type WaitlistHarness,
} from '../itest/waitlist.js';
import { ExpireDueHolds } from '../orders/expire-due-holds.command.js';
import type { PaymentHandoffView } from '../orders/order-views.js';
import { PurchaseStatus } from '../orders/purchase-seat.command.js';
import { QuoteSeat } from '../orders/quote-seat.query.js';
import type { SeatQuoteView } from '../orders/seat-quote-view.js';
import { settleConfirmedPayment } from '../orders/settle-payment.js';
import { FakePaymentScenario, intentRefOf } from '../payments/fake-payment-provider.js';

/**
 * The purchase from the pool (D-083): a buyer notified into an open window draws on the pool first,
 *   then on the public seats, in the hold's one statement; anyone else sees the date sold out. A
 *   pool hold's seats go back to the pool while the window is open, to public sale after it, and
 *   D-082's retake of a pool order draws as the purchase does.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const NOW = '2026-10-10T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const SERIES = '01a0fc03';
const BUYER = accountOf(SERIES, 999);
const STRANGER = accountOf(SERIES, 998);

let stack: StartedStack;
let h: WaitlistHarness;
let dates = 0;
let accounts = 0;

function nextAccount(): string {
  accounts += 1;
  return accountOf(SERIES, accounts);
}

/** Sold out at `capacity`, `listed` on the list, then a tier of `pool` opened for them. */
async function poolOpen(pool: number, listed: string[], capacity = 4): Promise<string> {
  dates += 1;
  const dateId = `01a0fc30-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await soldOutDate(h, dateId, capacity, BUYER, STARTS_AT);
  for (const accountId of listed) await join(h, dateId, accountId);
  await openTier(h, dateId, pool);
  return dateId;
}

function expectAddsUp(figures: Figures): void {
  const { seats_available, priority_pool_seats, seats_held, seats_sold, capacity_total } = figures;
  expect(seats_available + priority_pool_seats + seats_held + seats_sold).toBe(capacity_total);
}

async function poolSeatsOfHolds(dateId: string): Promise<{ state: string; pool_seats: number }[]> {
  return h.dataSource.query(
    `SELECT state, pool_seats FROM seat_hold WHERE date_id = $1 AND account_id <> $2
      ORDER BY created_at, id`,
    [dateId, BUYER],
  );
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  h = await startWaitlistHarness(stack, 'ticketing_pool_purchase_itest', NOW);
}, STARTUP_MS);

beforeEach(() => {
  h.fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
  travelTo(h.clock, NOW);
});

afterAll(async () => {
  await h?.close();
  await stack?.stop();
});

describe('a purchase from the priority pool', () => {
  it(
    'sells a notified buyer from the pool while the public is told the date is sold out',
    async () => {
      const notified = nextAccount();
      const dateId = await poolOpen(2, [notified]);

      expect((await refusalOf(buy(h, STRANGER, dateId, 1))).refusal.code).toBe(
        OrderErrorCode.SOLD_OUT,
      );
      const answer = await buy(h, notified, dateId, 2);

      expect(answer.status).toBe(PurchaseStatus.PAID);
      const figures = await figuresOf(h.dataSource, dateId);
      expect(figures).toMatchObject({ seats_available: 0, priority_pool_seats: 0, seats_sold: 6 });
      expectAddsUp(figures);
      expect(await poolSeatsOfHolds(dateId)).toEqual([
        { state: SeatHoldState.CONSUMED, pool_seats: 2 },
      ]);
    },
    CASE_MS,
  );

  it(
    'draws on the pool first, then on the public seats',
    async () => {
      const notified = nextAccount();
      const dateId = await poolOpen(2, [notified]);
      await openTier(h, dateId, 1, false);

      await buy(h, notified, dateId, 3);

      const figures = await figuresOf(h.dataSource, dateId);
      expect(figures).toMatchObject({ seats_available: 0, priority_pool_seats: 0, seats_sold: 7 });
      expectAddsUp(figures);
      expect(await poolSeatsOfHolds(dateId)).toEqual([
        { state: SeatHoldState.CONSUMED, pool_seats: 2 },
      ]);
    },
    CASE_MS,
  );

  it(
    'refuses a notified buyer more than the pool and the public seats hold together',
    async () => {
      const notified = nextAccount();
      const dateId = await poolOpen(2, [notified]);

      expect((await refusalOf(buy(h, notified, dateId, 3))).refusal.code).toBe(
        OrderErrorCode.SOLD_OUT,
      );
      expect(await figuresOf(h.dataSource, dateId)).toMatchObject({ priority_pool_seats: 2 });
    },
    CASE_MS,
  );

  it(
    'quotes a notified buyer the window, valid no later than its end',
    async () => {
      const notified = nextAccount();
      const dateId = await poolOpen(2, [notified]);
      const priorityUntil = priorityUntilOf(NOW);
      travelTo(h.clock, plusSeconds(priorityUntil, -30));

      const quote = (accountId: string): Promise<PerishableResponse<SeatQuoteView>> =>
        h.queries.execute(new QuoteSeat(dateId, { tier: PriceTier.FULL, quantity: 1 }, accountId));

      const told = await quote(notified);
      expect(told.data.priorityUntil).toBe(priorityUntil);
      expect(told.validUntil).toBe(priorityUntil);
      const stranger = await quote(STRANGER);
      expect(stranger.data).not.toHaveProperty('priorityUntil');
    },
    CASE_MS,
  );
});

describe("a pool hold's seats", () => {
  it(
    'go back to the pool when the hold expires in the window, then to public sale after it',
    async () => {
      const notified = nextAccount();
      const dateId = await poolOpen(2, [notified]);
      h.fake.scenarioOf = () => FakePaymentScenario.REQUIRE_ACTION;

      const first = await buy(h, notified, dateId, 2);
      expect(first.status).toBe(PurchaseStatus.AWAITING_PAYMENT);
      expectAddsUp(await figuresOf(h.dataSource, dateId));
      travelTo(h.clock, plusMinutes(NOW, HOLD_MINUTES_CHECKOUT));
      await h.commands.execute(new ExpireDueHolds());
      expect(await figuresOf(h.dataSource, dateId)).toMatchObject({
        seats_available: 0,
        priority_pool_seats: 2,
        seats_held: 0,
      });

      const windowEnd = plusHours(NOW, WAITLIST_PRIORITY_HOURS);
      travelTo(h.clock, plusMinutes(windowEnd, -5));
      await buy(h, notified, dateId, 2);
      travelTo(h.clock, windowEnd);
      await h.commands.execute(new EndPriorityWindows());
      expect(await figuresOf(h.dataSource, dateId)).toMatchObject({
        seats_available: 0,
        priority_pool_seats: 0,
        seats_held: 2,
        priority_until: null,
      });
      travelTo(h.clock, plusMinutes(windowEnd, HOLD_MINUTES_CHECKOUT));
      await h.commands.execute(new ExpireDueHolds());

      const figures = await figuresOf(h.dataSource, dateId);
      expect(figures).toMatchObject({ seats_available: 2, priority_pool_seats: 0, seats_held: 0 });
      expectAddsUp(figures);
    },
    CASE_MS,
  );

  it(
    "are taken again from the pool by D-082's retake while the window is open",
    async () => {
      const notified = nextAccount();
      const dateId = await poolOpen(2, [notified]);
      h.fake.scenarioOf = () => FakePaymentScenario.REQUIRE_ACTION;
      const handoff = (await buy(h, notified, dateId, 2)).response.envelope
        .data as PaymentHandoffView;
      travelTo(h.clock, plusMinutes(NOW, HOLD_MINUTES_CHECKOUT));
      await h.commands.execute(new ExpireDueHolds());

      const state = await h.transactions.run(async (transaction) => {
        const order = await transaction.orders.findById(handoff.orderId);
        if (order === null) throw new Error('no order');
        const pending = await settleConfirmedPayment(
          transaction,
          order,
          intentRefOf(handoff.orderId),
          h.clock.now(),
          null,
        );
        await transaction.orders.save(order);
        await pending?.();
        return order.snapshot.state;
      });

      expect(state).toBe(OrderState.PAID);
      const figures = await figuresOf(h.dataSource, dateId);
      expect(figures).toMatchObject({ seats_available: 0, priority_pool_seats: 0, seats_sold: 6 });
      expectAddsUp(figures);
    },
    CASE_MS,
  );
});
