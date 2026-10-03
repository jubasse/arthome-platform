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
  OrderState,
  SeatHoldOrigin,
  SeatHoldState,
} from '@arthome/core';

import { CLOCK } from '../clock.js';
import { HoldExpirySweeper } from './hold-expiry-sweeper.js';
import { HoldExpiryModule } from './hold-expiry.module.js';
import { OrdersModule } from './orders.module.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { SalesClosingSweeper } from '../date-sales/sales-closing-sweeper.js';
import { SalesClosingModule } from '../date-sales/sales-closing.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { FULL_PRICE_MINOR, nextKey, putOnSale } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { FakePaymentProvider, FakePaymentScenario } from '../payments/fake-payment-provider.js';
import { PaymentWebhooksModule } from '../payments/payment-webhooks.module.js';
import { PaymentWorker } from '../payments/payment-worker.js';
import { PaymentWorkerModule } from '../payments/payment-worker.module.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/**
 * The T3 correctness review's case on the expiry pass's plan, as the reviewer wrote it: its orders
 *   found by index, not by reading every order ever placed.
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

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_expiry_plan_itest');
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

describe('the hold expiry pass (adr-ticketing.md §6)', () => {
  it(
    'finds the orders of its due holds without reading every order ever placed',
    async () => {
      const dateId = await dateOnSale();
      const now = new Date(clock.nowMs());
      await dataSource.query(
        `INSERT INTO seat_hold (id, date_id, tier, quantity, origin, origin_ref, expires_at,
                                state, version)
         SELECT ('01a0fdbb-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, $1, $2, 1, $3,
                ('01a0fdcc-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, $4, $5, 2
           FROM generate_series(1, 20000) AS n`,
        [dateId, PriceTier.FULL, SeatHoldOrigin.CHECKOUT, now, SeatHoldState.CONSUMED],
      );
      await dataSource.query(
        `INSERT INTO seat_order (id, reference, idempotency_key, fingerprint, date_id, channel_id,
                                 tier, quantity, currency_code, unit_price_minor, tier_total_minor,
                                 service_fee_minor, discount_minor, total_minor, hold_id,
                                 expires_at, state, placed_at, version)
         SELECT ('01a0fdcc-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
                'ATH-PLAN-' || n, gen_random_uuid(), 'plan', $1, $2, $3, 1, 'EUR', 2400, 2400, 0,
                0, 2400, ('01a0fdbb-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, $4, $5, $4, 2
           FROM generate_series(1, 20000) AS n`,
        [dateId, CHANNEL, PriceTier.FULL, now, OrderState.PAID],
      );
      await awaitingOrder(dateId, 1);
      await dataSource.query('ANALYZE seat_hold');
      await dataSource.query('ANALYZE seat_order');

      const plan = await dataSource.query<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT hold.id AS hold_id, placed.id AS order_id, hold.date_id, hold.quantity
           FROM seat_hold AS hold
           JOIN seat_order AS placed ON placed.hold_id = hold.id
          WHERE hold.state = $1 AND hold.expires_at <= $2
          ORDER BY hold.expires_at
          LIMIT $3
            FOR UPDATE OF hold, placed SKIP LOCKED`,
        [SeatHoldState.ACTIVE, new Date(clock.nowMs() + HOLD_MS), 500],
      );
      const text = plan.map((line) => line['QUERY PLAN']).join('\n');

      expect(text).not.toMatch(/Seq Scan on seat_order/);
    },
    CASE_MS,
  );
});
