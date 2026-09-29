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

import { FixedClock, MINUTE_MS, PriceTier } from '@arthome/core';

import { CLOCK } from '../clock.js';
import { OrderState, SeatHoldState } from './commerce-vocabulary.js';
import { ExpireDueHolds } from './expire-due-holds.command.js';
import { HoldExpirySweeper } from './hold-expiry-sweeper.js';
import { HoldExpiryModule } from './hold-expiry.module.js';
import { OrdersModule } from './orders.module.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { SalesClosingSweeper } from '../date-sales/sales-closing-sweeper.js';
import { SalesClosingModule } from '../date-sales/sales-closing.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { FULL_PRICE_MINOR, nextKey, purchaseOf, putOnSale } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
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
 * The T3 correctness review's cases on the date's row under payments, as the reviewer wrote them: a
 *   payment inserting its seats does not hold the row a hold needs (adr-ticketing.md §2, §3), and
 *   expiry passes racing late payments keep every seat accounted for.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const HOLD_MS = 15 * MINUTE_MS;
const CHANNEL = '01a0fd0c-0000-7000-8000-000000000001';

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let clock: FixedClock;
let fake: FakePaymentProvider;
let dates = 0;

const commands = (): CommandBus => app.get(CommandBus);

function nextDateId(): string {
  dates += 1;
  return `01a0fd00-0000-7000-8000-${String(dates).padStart(12, '0')}`;
}

async function dateOnSale(capacity = 10): Promise<string> {
  const dateId = nextDateId();
  await putOnSale(commands(), { dateId, channelId: CHANNEL, capacity }, clock.now());
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

function deliver({ body, signature }: SignedWebhook) {
  return app.inject({
    method: 'POST',
    url: '/v1/payments/webhook',
    headers: { 'content-type': 'application/json', [fake.signatureHeader]: signature },
    payload: body,
  });
}

function applyEvents(): Promise<number> {
  return commands().execute(new ApplyPaymentEvents(100));
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_payment_races_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock('2026-09-28T10:00:00.000Z');
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
    ],
    providers: EDGE_PROVIDERS,
    dataSource,
    rawBody: true,
    overrides: [
      [CLOCK, clock],
      [FakePaymentProvider, fake],
      [PUBLIC_WEB_ORIGIN, 'http://storefront.test'],
      [PaymentWorker, {}],
      [HoldExpirySweeper, {}],
      [SalesClosingSweeper, {}],
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

describe('the hot row (adr-ticketing.md §2, §3)', () => {
  it(
    'is not held by a payment while it inserts its seats: a hold on the same date does not wait',
    async () => {
      const dateId = await dateOnSale();
      await dataSource.query(`
        CREATE FUNCTION review_slow_seat_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(1); RETURN NULL; END $$`);
      await dataSource.query(`
        CREATE TRIGGER review_slow_seat_insert BEFORE INSERT ON seat
        FOR EACH STATEMENT EXECUTE FUNCTION review_slow_seat_insert()`);
      try {
        const paying = commands().execute(purchaseOf(dateId, 1));
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

        // Tx A's own statement, as a second buyer's purchase runs it, bounded well below the
        //   ADR's 100 ms lock-wait threshold's multiple.
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
        await paying;

        expect(waited).toBeNull();
      } finally {
        await dataSource.query('DROP TRIGGER review_slow_seat_insert ON seat');
        await dataSource.query('DROP FUNCTION review_slow_seat_insert()');
      }
    },
    CASE_MS,
  );
});

describe('expiry passes racing late payments on one date (hunting a double return)', () => {
  it(
    'keeps available + sold + held equal to the capacity, one seat row per seat sold',
    async () => {
      const capacity = 20;
      const dateId = await dateOnSale(capacity);
      const orderIds: string[] = [];
      for (let buyer = 0; buyer < capacity; buyer += 1) {
        orderIds.push(await awaitingOrder(dateId, 1));
      }
      for (const orderId of orderIds) await deliver(fake.completeAction(intentRefOf(orderId)));
      clock.advance(HOLD_MS);

      const passes = await Promise.allSettled([
        commands().execute(new ExpireDueHolds(3)),
        commands().execute(new ExpireDueHolds(3)),
        commands().execute(new ApplyPaymentEvents(100)),
        commands().execute(new ExpireDueHolds(5)),
        commands().execute(new ApplyPaymentEvents(100)),
        commands().execute(new ExpireDueHolds()),
        commands().execute(new ApplyPaymentEvents(100)),
      ]);
      expect(passes.filter(({ status }) => status === 'rejected')).toEqual([]);
      await commands().execute(new ExpireDueHolds());
      clock.advance(400_000);
      await applyEvents();

      const [gauge] = await dataSource.query<
        { seats_available: number; seats_sold: number; held: number; seats: number }[]
      >(
        `SELECT sales.seats_available, sales.seats_sold,
                (SELECT coalesce(sum(quantity), 0)::int FROM seat_hold
                  WHERE date_id = $1 AND state = $2) AS held,
                (SELECT count(*)::int FROM seat WHERE date_id = $1) AS seats
           FROM date_sales AS sales WHERE date_id = $1`,
        [dateId, SeatHoldState.ACTIVE],
      );
      expect(gauge).toEqual({ seats_available: 0, seats_sold: capacity, held: 0, seats: capacity });
      const [states] = await dataSource.query<{ paid: number; dead: number }[]>(
        `SELECT (SELECT count(*)::int FROM seat_order WHERE date_id = $1 AND state = $3) AS paid,
                (SELECT count(*)::int FROM stripe_event_inbox
                  WHERE order_id = ANY($2) AND dead_at IS NOT NULL) AS dead`,
        [dateId, orderIds, OrderState.PAID],
      );
      expect(states).toEqual({ paid: capacity, dead: 0 });
    },
    CASE_MS,
  );
});
