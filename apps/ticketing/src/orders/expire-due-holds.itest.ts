import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { CommandBus, CqrsModule, QueryBus } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiErrorCode, FixedClock, MINUTE_MS, OrderState, SeatHoldState } from '@arthome/core';

import { ExpireDueHolds } from './expire-due-holds.command.js';
import { ExpireDueHoldsHandler } from './expire-due-holds.handler.js';
import { GetOrderHandler } from './get-order.handler.js';
import { GetOrder } from './get-order.query.js';
import type { PaymentHandoffView } from './order-views.js';
import type { PurchaseAnswer } from './purchase-seat.command.js';
import { PurchaseSeatHandler } from './purchase-seat.handler.js';
import { CLOCK } from '../clock.js';
import { ApplyCatalogDateFactHandler } from '../date-sales/apply-catalog-date-fact.handler.js';
import { OpenCapacityTierHandler } from '../date-sales/open-capacity-tier.handler.js';
import { SetDatePricesHandler } from '../date-sales/set-date-prices.handler.js';
import { purchaseOf, putOnSale, ITEST_BUYER_ACCOUNT_ID } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { FakePaymentProvider, FakePaymentScenario } from '../payments/fake-payment-provider.js';
import { OwedRefunds } from '../payments/owed-refunds.js';
import { PAYMENT_PORT } from '../payments/payment-tokens.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * adr-ticketing.md §6 against a real Postgres: what a pass of the sweeper expires, returns and
 *   fails, what it leaves to a payment holding the order, and its batch.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const CHANNEL = '01a0fd0c-0000-7000-8000-000000000001';
const HOLD_MS = 15 * MINUTE_MS;

let stack: StartedStack;
let dataSource: DataSource;
let cqrs: TestingModule;
let commands: CommandBus;
let clock: FixedClock;
let fake: FakePaymentProvider;
let dates = 0;

async function dateOnSale(capacity = 10): Promise<string> {
  dates += 1;
  const dateId = `01a0fd00-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await putOnSale(commands, { dateId, channelId: CHANNEL, capacity }, clock.now());
  return dateId;
}

async function awaitingOrder(dateId: string, quantity: number): Promise<string> {
  fake.scenarioOf = () => FakePaymentScenario.REQUIRE_ACTION;
  const answer: PurchaseAnswer = await commands.execute(purchaseOf(dateId, quantity));
  return (answer.response.envelope.data as PaymentHandoffView).orderId;
}

async function seatsAvailable(dateId: string): Promise<number> {
  const [row] = await dataSource.query<{ seats_available: number }[]>(
    'SELECT seats_available FROM date_sales WHERE date_id = $1',
    [dateId],
  );
  return row?.seats_available ?? Number.NaN;
}

async function orderRow(
  orderId: string,
): Promise<{ state: string; intent_cancel_owed_at: Date | null; hold_state: string }> {
  const [row] = await dataSource.query<
    { state: string; intent_cancel_owed_at: Date | null; hold_state: string }[]
  >(
    `SELECT placed.state, placed.intent_cancel_owed_at, hold.state AS hold_state
       FROM seat_order AS placed JOIN seat_hold AS hold ON hold.id = placed.hold_id
      WHERE placed.id = $1`,
    [orderId],
  );
  if (row === undefined) throw new Error(`no order ${orderId}`);
  return row;
}

function expire(batch?: number): Promise<number> {
  return commands.execute(new ExpireDueHolds(batch));
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_hold_expiry_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock('2026-09-28T10:00:00.000Z');
  fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  cqrs = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      TicketingTransactions,
      ApplyCatalogDateFactHandler,
      OpenCapacityTierHandler,
      SetDatePricesHandler,
      PurchaseSeatHandler,
      GetOrderHandler,
      ExpireDueHoldsHandler,
      { provide: DataSource, useValue: dataSource },
      { provide: CLOCK, useValue: clock },
      OwedRefunds,
      { provide: PAYMENT_PORT, useValue: fake },
      { provide: PUBLIC_WEB_ORIGIN, useValue: 'http://storefront.test' },
    ],
  }).compile();
  await cqrs.init();
  commands = cqrs.get(CommandBus);
}, STARTUP_MS);

beforeEach(async () => {
  fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
  // Every hold an earlier case left active is past its expiry here, and given back.
  clock.advance(HOLD_MS + 1_000);
  let expired = await expire();
  while (expired > 0) expired = await expire();
});

afterAll(async () => {
  await cqrs?.close();
  await dataSource?.destroy();
  await stack?.stop();
});

describe('a pass of the hold expiry', () => {
  it(
    'expires a hold nobody paid, gives its seats back, and fails its order owing its intent',
    async () => {
      const dateId = await dateOnSale();
      const expiring = await awaitingOrder(dateId, 2);
      fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
      await commands.execute(purchaseOf(dateId, 1));
      clock.advance(10 * MINUTE_MS);
      const younger = await awaitingOrder(dateId, 3);
      expect(await seatsAvailable(dateId)).toBe(4);

      clock.advance(5 * MINUTE_MS);
      expect(await expire()).toBe(1);

      expect(await orderRow(expiring)).toEqual({
        state: OrderState.FAILED,
        intent_cancel_owed_at: new Date(clock.now()),
        hold_state: SeatHoldState.EXPIRED,
      });
      expect(await orderRow(younger)).toMatchObject({ hold_state: SeatHoldState.ACTIVE });
      expect(await seatsAvailable(dateId)).toBe(6);
      const detail = await cqrs
        .get(QueryBus)
        .execute(new GetOrder(expiring, ITEST_BUYER_ACCOUNT_ID));
      expect(detail).toMatchObject({ order: { state: OrderState.FAILED }, tickets: [] });
      expect(detail).not.toHaveProperty('handoff');
      expect(await expire()).toBe(0);
    },
    CASE_MS,
  );

  it(
    'takes at most its batch, and the next pass takes the rest: every seat comes back',
    async () => {
      const dateId = await dateOnSale(6);
      for (let index = 0; index < 3; index += 1) await awaitingOrder(dateId, 2);
      expect(await seatsAvailable(dateId)).toBe(0);
      clock.advance(HOLD_MS);

      expect(await expire(2)).toBe(2);
      expect(await expire(2)).toBe(1);
      expect(await expire(2)).toBe(0);

      expect(await seatsAvailable(dateId)).toBe(6);
    },
    CASE_MS,
  );

  it(
    'leaves a hold whose order a payment holds to that payment, and takes it the pass after',
    async () => {
      const dateId = await dateOnSale();
      const orderId = await awaitingOrder(dateId, 2);
      clock.advance(HOLD_MS);
      const payment = dataSource.createQueryRunner();
      await payment.connect();
      await payment.startTransaction();
      try {
        await payment.query('SELECT id FROM seat_order WHERE id = $1 FOR UPDATE', [orderId]);

        const started = Date.now();
        expect(await expire()).toBe(0);
        expect(Date.now() - started).toBeLessThan(1_000);
      } finally {
        await payment.commitTransaction();
        await payment.release();
      }

      expect(await expire()).toBe(1);
      expect(await orderRow(orderId)).toMatchObject({ state: OrderState.FAILED });
    },
    CASE_MS,
  );

  it(
    'fails an order whose hold went back while the provider did not answer, once past its expiry',
    async () => {
      const dateId = await dateOnSale();
      fake.scenarioOf = () => FakePaymentScenario.UNAVAILABLE;
      await expect(commands.execute(purchaseOf(dateId, 2))).rejects.toMatchObject({
        refusal: { code: ApiErrorCode.SERVICE_UNAVAILABLE },
      });
      const [pending] = await dataSource.query<{ id: string }[]>(
        'SELECT id FROM seat_order WHERE date_id = $1',
        [dateId],
      );
      clock.advance(HOLD_MS);

      expect(await expire()).toBe(0);

      expect(await orderRow(pending?.id ?? '')).toEqual({
        state: OrderState.FAILED,
        intent_cancel_owed_at: null,
        hold_state: SeatHoldState.RELEASED,
      });
      expect(await seatsAvailable(dateId)).toBe(10);
    },
    CASE_MS,
  );
});
