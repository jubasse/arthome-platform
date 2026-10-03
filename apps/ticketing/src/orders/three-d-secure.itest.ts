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
  OrderErrorCode,
  PriceTier,
  OrderState,
  PaymentEventKind,
} from '@arthome/core';

import { CLOCK } from '../clock.js';
import { HoldExpirySweeper } from './hold-expiry-sweeper.js';
import { HoldExpiryModule } from './hold-expiry.module.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { SalesClosingSweeper } from '../date-sales/sales-closing-sweeper.js';
import { SalesClosingModule } from '../date-sales/sales-closing.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { OrdersModule } from './orders.module.js';
import { FULL_PRICE_MINOR, nextKey, putOnSale } from '../itest/sales.js';
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
 * The T3 correctness review's cases on 3-D Secure, as the reviewer wrote them: a buyer gets the
 *   handoff and its client secret whether the `requires_action` webhook is applied before tx B, or
 *   after a crash between tx A and tx B, never `order.sold_out` while their seats are held.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const DEADLINE_AHEAD_MS = 60 * MINUTE_MS;
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

async function orderStateOf(orderId: string): Promise<string> {
  const answer = await app.inject({
    method: 'GET',
    url: `/v1/orders/${orderId}`,
    headers: { 'x-arthome-deadline': new Date(clock.nowMs() + DEADLINE_AHEAD_MS).toISOString() },
  });
  expect(answer.statusCode).toBe(200);
  return answer.json<{ data: { order: { state: string } } }>().data.order.state;
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_three_d_secure_itest');
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

describe('a purchase resumed after its webhook recorded the intent (crash between tx A and tx B)', () => {
  it(
    'answers the handoff its hold still waits on, not sold out',
    async () => {
      const dateId = await dateOnSale();
      const key = nextKey();
      let orderId = '';
      fake.scenarioOf = (request) => {
        orderId = request.orderId;
        return FakePaymentScenario.REQUIRE_ACTION;
      };
      await dataSource.query(`
        CREATE FUNCTION review_tx_b_crash() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'review: the process died in tx B'; END $$`);
      await dataSource.query(`
        CREATE TRIGGER review_tx_b_crash BEFORE UPDATE ON seat_order
        FOR EACH ROW EXECUTE FUNCTION review_tx_b_crash()`);
      const post = () =>
        app.inject({
          method: 'POST',
          url: '/v1/orders/seats',
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          payload: {
            dateId,
            tier: PriceTier.FULL,
            quantity: 2,
            expectedTotal: { amountMinor: FULL_PRICE_MINOR * 2, currencyCode: 'EUR' },
          },
        });
      try {
        expect((await post()).statusCode).toBe(500);
      } finally {
        await dataSource.query('DROP TRIGGER review_tx_b_crash ON seat_order');
        await dataSource.query('DROP FUNCTION review_tx_b_crash()');
      }
      await deliver(fake.webhookOf(intentRefOf(orderId), PaymentEventKind.INTENT_REQUIRES_ACTION));
      await applyEvents();
      expect(await orderStateOf(orderId)).toBe(OrderState.AWAITING_ACTION);

      const resumed = await post();

      expect.soft(resumed.json()).not.toMatchObject({ error: { code: OrderErrorCode.SOLD_OUT } });
      expect(resumed.statusCode).toBe(202);
      expect(resumed.json()).toMatchObject({
        data: { orderId, clientSecret: `${intentRefOf(orderId)}_secret` },
      });
    },
    CASE_MS,
  );
});

describe('a requires_action webhook applied before the purchase reaches tx B', () => {
  it(
    'still answers the buyer 202 with the handoff and its client secret, not sold out',
    async () => {
      const dateId = await dateOnSale();
      fake.scenarioOf = () => FakePaymentScenario.REQUIRE_ACTION;
      const create = fake.createIntent.bind(fake);
      fake.createIntent = async (request) => {
        const intent = await create(request);
        await deliver(fake.webhookOf(intent.ref, PaymentEventKind.INTENT_REQUIRES_ACTION));
        await applyEvents();
        return intent;
      };
      try {
        const answer = await app.inject({
          method: 'POST',
          url: '/v1/orders/seats',
          headers: { 'content-type': 'application/json', 'idempotency-key': nextKey() },
          payload: {
            dateId,
            tier: PriceTier.FULL,
            quantity: 2,
            expectedTotal: { amountMinor: FULL_PRICE_MINOR * 2, currencyCode: 'EUR' },
          },
        });

        expect.soft(answer.json()).not.toMatchObject({ error: { code: OrderErrorCode.SOLD_OUT } });
        expect(answer.statusCode).toBe(202);
      } finally {
        fake.createIntent = create;
      }
    },
    CASE_MS,
  );
});
