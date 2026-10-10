import { DateOutcome as WireDateOutcome } from '@arthome-platform/events';
import { Outcome } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  httpApp,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { CommandBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FixedClock,
  MINUTE_MS,
  PriceTier,
  RefundReason,
  SeatCancelReason,
  SeatHoldState,
  SeatState,
  Service,
} from '@arthome/core';

import { DateOutcomeSweeper } from './date-outcome-sweeper.js';
import { DateOutcomesModule } from './date-outcomes.module.js';
import { SettleDateOutcomes } from './settle-date-outcomes.command.js';
import { CLOCK } from '../clock.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { SalesClosingSweeper } from '../date-sales/sales-closing-sweeper.js';
import { SalesClosingModule } from '../date-sales/sales-closing.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { delivered, outcomeDeclared } from '../itest/catalog-messages.js';
import {
  FULL_PRICE_MINOR,
  ITEST_BUYER_ACCOUNT_ID,
  nextKey,
  purchaseOf,
  putOnSale,
} from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { ExpireDueHolds } from '../orders/expire-due-holds.command.js';
import { HoldExpirySweeper } from '../orders/hold-expiry-sweeper.js';
import { HoldExpiryModule } from '../orders/hold-expiry.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PurchaseStatus } from '../orders/purchase-seat.command.js';
import { ApplyPaymentEvents } from '../payments/apply-payment-events.command.js';
import {
  FakePaymentProvider,
  FakePaymentScenario,
  intentRefOf,
  type SignedWebhook,
} from '../payments/fake-payment-provider.js';
import { PaymentWebhooksModule } from '../payments/payment-webhooks.module.js';
import { PaymentWorker } from '../payments/payment-worker.js';
import { PaymentWorkerModule } from '../payments/payment-worker.module.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/**
 * Payments on a date since cancelled (D-097, HANDOVER §0n): one confirmed after the cancellation
 *   gets no seat and is refunded `date_cancelled`, its hold active or gone; one that read the
 *   date before the cancellation committed seats its order, which the pass then refunds, the date
 *   kept open while its hold was active.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const HOLD_MS = 15 * MINUTE_MS;
const CAPACITY = 10;
const CHANNEL = '01a0e60c-0000-7000-8000-000000000001';

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let clock: FixedClock;
let fake: FakePaymentProvider;
let dates = 0;

const commands = (): CommandBus => app.get(CommandBus);
const settle = (): Promise<number> => commands().execute(new SettleDateOutcomes());

async function dateOnSale(): Promise<string> {
  dates += 1;
  const dateId = `01a0e600-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await putOnSale(commands(), { dateId, channelId: CHANNEL, capacity: CAPACITY }, clock.now());
  return dateId;
}

async function awaitingOrder(dateId: string, quantity = 2): Promise<string> {
  fake.scenarioOf = () => FakePaymentScenario.REQUIRE_ACTION;
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
  fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
  return answer.json<{ data: { orderId: string } }>().data.orderId;
}

async function deliver({ body, signature }: SignedWebhook): Promise<void> {
  const answer = await app.inject({
    method: 'POST',
    url: '/v1/payments/webhook',
    headers: { 'content-type': 'application/json', [fake.signatureHeader]: signature },
    payload: body,
  });
  expect(answer.statusCode).toBe(200);
  await commands().execute(new ApplyPaymentEvents(100));
}

async function cancel(dateId: string): Promise<void> {
  expect(
    await applyCatalogDateMessage(
      commands(),
      delivered(outcomeDeclared(dateId, WireDateOutcome.CANCELLED, clock.now())),
    ),
  ).toBe(Outcome.APPLIED);
}

async function settledAt(dateId: string): Promise<Date | null> {
  const [row] = await dataSource.query<{ settled_at: Date | null }[]>(
    'SELECT settled_at FROM date_outcome_settlement WHERE date_id = $1',
    [dateId],
  );
  return row?.settled_at ?? null;
}

async function ledgerOf(orderId: string) {
  const refunds = await dataSource.query<
    { reason: string; amount_minor: string; seat_id: string | null }[]
  >('SELECT reason, amount_minor, seat_id FROM order_refund WHERE order_id = $1', [orderId]);
  const seats = await dataSource.query<{ state: string; cancel_reason: string | null }[]>(
    'SELECT state, cancel_reason FROM seat WHERE order_id = $1',
    [orderId],
  );
  const [hold] = await dataSource.query<{ state: string }[]>(
    `SELECT hold.state FROM seat_hold AS hold
       JOIN seat_order AS placed ON placed.hold_id = hold.id
      WHERE placed.id = $1`,
    [orderId],
  );
  return { refunds, seats, holdState: hold?.state };
}

async function countersOf(dateId: string) {
  const [row] = await dataSource.query<{ seats_available: number; seats_sold: number }[]>(
    'SELECT seats_available, seats_sold FROM date_sales WHERE date_id = $1',
    [dateId],
  );
  return row;
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_late_payment_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock('2026-10-04T10:00:00.000Z');
  fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  app = await httpApp({
    imports: [
      OrdersModule,
      PaymentWebhooksModule,
      PaymentWorkerModule,
      HoldExpiryModule,
      SalesClosingModule,
      DateSalesModule,
      CatalogFactsModule,
      DateOutcomesModule,
    ],
    providers: EDGE_PROVIDERS,
    caller: { service: Service.TICKETING, clock, accountId: ITEST_BUYER_ACCOUNT_ID },
    dataSource,
    rawBody: true,
    overrides: [
      [CLOCK, clock],
      [FakePaymentProvider, fake],
      [PUBLIC_WEB_ORIGIN, 'http://storefront.test'],
      [PaymentWorker, {}],
      [HoldExpirySweeper, {}],
      [SalesClosingSweeper, {}],
      [DateOutcomeSweeper, {}],
    ],
  });
}, STARTUP_MS);

beforeEach(() => {
  fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
  fake.down = false;
});

afterAll(async () => {
  await app?.close();
  await stack?.stop();
});

describe('a payment on a date since cancelled', () => {
  it(
    'through a hold still active: no seat, the hold released, refunded date_cancelled',
    async () => {
      const dateId = await dateOnSale();
      const orderId = await awaitingOrder(dateId);
      await cancel(dateId);
      await settle();
      await settle();

      expect(await settledAt(dateId)).toBeNull();

      await deliver(fake.completeAction(intentRefOf(orderId)));

      expect(await ledgerOf(orderId)).toEqual({
        refunds: [
          {
            reason: RefundReason.DATE_CANCELLED,
            amount_minor: String(2 * FULL_PRICE_MINOR),
            seat_id: null,
          },
        ],
        seats: [],
        holdState: SeatHoldState.RELEASED,
      });
      expect(await countersOf(dateId)).toEqual({ seats_available: CAPACITY, seats_sold: 0 });
      await settle();
      expect(await settledAt(dateId)).not.toBeNull();
    },
    CASE_MS,
  );

  it(
    'past its hold: no seat, refunded date_cancelled rather than hold_expired_capacity_lost',
    async () => {
      const dateId = await dateOnSale();
      const orderId = await awaitingOrder(dateId);
      clock.advance(HOLD_MS);
      await commands().execute(new ExpireDueHolds());
      await cancel(dateId);

      await deliver(fake.completeAction(intentRefOf(orderId)));

      expect(await ledgerOf(orderId)).toEqual({
        refunds: [
          {
            reason: RefundReason.DATE_CANCELLED,
            amount_minor: String(2 * FULL_PRICE_MINOR),
            seat_id: null,
          },
        ],
        seats: [],
        holdState: SeatHoldState.EXPIRED,
      });
      expect(await countersOf(dateId)).toEqual({ seats_available: CAPACITY, seats_sold: 0 });
    },
    CASE_MS,
  );

  it(
    'read the date before the cancellation committed: seated, then refunded by the pass',
    async () => {
      const dateId = await dateOnSale();
      await dataSource.query(`
        CREATE FUNCTION itest_slow_seat_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(2); RETURN NULL; END $$`);
      await dataSource.query(`
        CREATE TRIGGER itest_slow_seat_insert BEFORE INSERT ON seat
        FOR EACH STATEMENT EXECUTE FUNCTION itest_slow_seat_insert()`);
      let orderId: string;
      try {
        const paying = commands().execute(purchaseOf(dateId, 2));
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
        await cancel(dateId);
        await settle();
        await settle();

        expect(await settledAt(dateId)).toBeNull();

        const answer = await paying;
        expect(answer.status).toBe(PurchaseStatus.PAID);
        const [placed] = await dataSource.query<{ id: string }[]>(
          'SELECT id FROM seat_order WHERE date_id = $1',
          [dateId],
        );
        orderId = placed?.id ?? '';
      } finally {
        await dataSource.query('DROP TRIGGER itest_slow_seat_insert ON seat');
        await dataSource.query('DROP FUNCTION itest_slow_seat_insert()');
      }

      expect(await settle()).toBe(1);
      expect(await settledAt(dateId)).not.toBeNull();
      expect(await ledgerOf(orderId)).toEqual({
        refunds: [
          {
            reason: RefundReason.DATE_CANCELLED,
            amount_minor: String(2 * FULL_PRICE_MINOR),
            seat_id: null,
          },
        ],
        seats: [
          { state: SeatState.CANCELLED, cancel_reason: SeatCancelReason.DATE_CANCELLED },
          { state: SeatState.CANCELLED, cancel_reason: SeatCancelReason.DATE_CANCELLED },
        ],
        holdState: SeatHoldState.CONSUMED,
      });
    },
    CASE_MS,
  );
});
