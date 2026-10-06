import { RETRY_DELAYS_MS } from '@arthome-platform/messaging';
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

import { FixedClock, MINUTE_MS, OrderState, PriceTier, Service } from '@arthome/core';

import { ApplyPaymentEvents } from './apply-payment-events.command.js';
import {
  FakePaymentProvider,
  FakePaymentScenario,
  intentRefOf,
  type SignedWebhook,
} from './fake-payment-provider.js';
import { PaymentWebhooksModule } from './payment-webhooks.module.js';
import { PaymentWorker } from './payment-worker.js';
import { PaymentWorkerModule } from './payment-worker.module.js';
import { CLOCK } from '../clock.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { SalesClosingSweeper } from '../date-sales/sales-closing-sweeper.js';
import { SalesClosingModule } from '../date-sales/sales-closing.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { FULL_PRICE_MINOR, nextKey, putOnSale, ITEST_BUYER_ACCOUNT_ID } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { HoldExpirySweeper } from '../orders/hold-expiry-sweeper.js';
import { HoldExpiryModule } from '../orders/hold-expiry.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/**
 * The T3 correctness review's cases on the payment worker, as the reviewer wrote them: a webhook
 *   retried after a transient failure, backed off and given up on; an event about no order kept and
 *   ignored. Its owed-refund cases are the worker process's queues' now
 *   (`provider-call-queues.itest.ts`).
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

async function orderStateOf(orderId: string): Promise<string> {
  const answer = await app.inject({
    method: 'GET',
    url: `/v1/orders/${orderId}`,
    headers: { 'x-arthome-deadline': new Date(clock.nowMs() + DEADLINE_AHEAD_MS).toISOString() },
  });
  expect(answer.statusCode).toBe(200);
  return answer.json<{ data: { order: { state: string } } }>().data.order.state;
}

async function inboxRowOf(eventId: string) {
  const [row] = await dataSource.query<
    {
      applied_at: Date | null;
      dead_at: Date | null;
      attempts: number;
      retry_at: Date | null;
    }[]
  >('SELECT applied_at, dead_at, attempts, retry_at FROM stripe_event_inbox WHERE event_id = $1', [
    eventId,
  ]);
  return row;
}

function eventIdOf({ body }: SignedWebhook): string {
  return (JSON.parse(body.toString('utf8')) as { id: string }).id;
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_payment_worker_itest');
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

describe('the webhook worker after a transient failure (untested in T3)', () => {
  async function failingOrderUpdates(orderId: string): Promise<() => Promise<void>> {
    await dataSource.query(`
      CREATE FUNCTION review_transient_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'review: transient fault'; END $$`);
    await dataSource.query(`
      CREATE TRIGGER review_transient_fault BEFORE UPDATE ON seat_order
      FOR EACH ROW WHEN (OLD.id = '${orderId}'::uuid)
      EXECUTE FUNCTION review_transient_fault()`);
    return async () => {
      await dataSource.query('DROP TRIGGER IF EXISTS review_transient_fault ON seat_order');
      await dataSource.query('DROP FUNCTION IF EXISTS review_transient_fault()');
    };
  }

  it(
    'retries the event after its delay, and applies it once the fault cleared',
    async () => {
      const dateId = await dateOnSale();
      const orderId = await awaitingOrder(dateId);
      const confirmation = fake.completeAction(intentRefOf(orderId));
      const eventId = eventIdOf(confirmation);
      const clear = await failingOrderUpdates(orderId);
      try {
        await deliver(confirmation);
        await applyEvents();

        const failed = await inboxRowOf(eventId);
        expect(failed).toMatchObject({ applied_at: null, dead_at: null, attempts: 1 });
        const retryAt = failed?.retry_at?.getTime() ?? 0;
        expect(retryAt).toBeGreaterThanOrEqual(clock.nowMs() + 5_000);
        expect(retryAt).toBeLessThanOrEqual(clock.nowMs() + 6_000);
        expect(await orderStateOf(orderId)).toBe(OrderState.AWAITING_ACTION);

        expect(await applyEvents()).toBe(0);
        await clear();
        clock.advance(6_000);
        expect(await applyEvents()).toBe(1);

        expect(await inboxRowOf(eventId)).toMatchObject({ dead_at: null, attempts: 1 });
        expect((await inboxRowOf(eventId))?.applied_at).not.toBeNull();
        expect(await orderStateOf(orderId)).toBe(OrderState.PAID);
        const [counters] = await dataSource.query<
          { seats_available: number; seats_sold: number }[]
        >('SELECT seats_available, seats_sold FROM date_sales WHERE date_id = $1', [dateId]);
        expect(counters).toEqual({ seats_available: 8, seats_sold: 2 });
      } finally {
        await clear();
      }
    },
    CASE_MS,
  );

  it(
    'backs off by RETRY_DELAYS_MS, then gives the event up as a dead letter after the last',
    async () => {
      const dateId = await dateOnSale();
      const orderId = await awaitingOrder(dateId);
      const confirmation = fake.completeAction(intentRefOf(orderId));
      const eventId = eventIdOf(confirmation);
      const clear = await failingOrderUpdates(orderId);
      try {
        await deliver(confirmation);
        const waits: number[] = [];
        for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt += 1) {
          await applyEvents();
          const retryAt = (await inboxRowOf(eventId))?.retry_at?.getTime();
          if (retryAt === undefined) break;
          waits.push(retryAt - clock.nowMs());
          clock.advance(retryAt - clock.nowMs());
        }

        const given = await inboxRowOf(eventId);
        expect(given?.attempts).toBe(RETRY_DELAYS_MS.length + 1);
        expect.soft(waits).toHaveLength(RETRY_DELAYS_MS.length);
        RETRY_DELAYS_MS.forEach((delay, index) => {
          expect.soft(waits[index] ?? 0).toBeGreaterThanOrEqual(delay);
        });
        expect.soft(given?.dead_at).not.toBeNull();
        expect(given?.applied_at).toBeNull();
        expect(await orderStateOf(orderId)).toBe(OrderState.AWAITING_ACTION);
      } finally {
        await clear();
      }
    },
    CASE_MS,
  );
});

describe('an event the provider sends about no order of ours', () => {
  it(
    'is kept and ignored, not given up on as a dead letter',
    async () => {
      const body = Buffer.from(
        JSON.stringify({
          id: 'evt_review_unhandled',
          type: 'charge.succeeded',
          created: Math.floor(clock.nowMs() / 1_000),
          data: {
            object: { id: 'ch_review', metadata: { order_id: null }, last_payment_error: null },
          },
        }),
      );
      expect((await deliver({ body, signature: fake.sign(body, clock.now()) })).statusCode).toBe(
        200,
      );

      await applyEvents();

      const row = await inboxRowOf('evt_review_unhandled');
      expect(row?.dead_at).toBeNull();
      expect(row?.applied_at).not.toBeNull();
    },
    CASE_MS,
  );
});
