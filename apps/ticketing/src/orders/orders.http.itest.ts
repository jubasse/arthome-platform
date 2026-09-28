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
  OrderSchema,
  PaymentHandoffSchema,
  SeatQuoteSchema,
  TicketCardSchema,
} from '@arthome/contracts/ticketing';
import {
  ApiErrorCode,
  FailureNature,
  FixedClock,
  OrderErrorCode,
  OrderKind,
  PriceTier,
} from '@arthome/core';

import { OrderState } from './commerce-vocabulary.js';
import { OrdersModule } from './orders.module.js';
import { CLOCK } from '../clock.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { FULL_PRICE_MINOR, nextKey, putOnSale } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { FakePaymentProvider, FakePaymentScenario } from '../payments/fake-payment-provider.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/**
 * The storefront's three operations through the module graph the API boots, over HTTP, their
 *   bodies parsed by the contract's own schemas; `TicketCard` without the `date` the BFF adds. What
 *   each purchase decides is `purchase.itest.ts`'s.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const NOW = '2026-09-28T10:00:00.000Z';
const DEADLINE = '2026-09-28T11:00:00.000Z';
const CHANNEL = '01a0fc0c-0000-7000-8000-000000000001';

const TicketWithoutDateSchema = TicketCardSchema.omit({ date: true });

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let fake: FakePaymentProvider;
let dates = 0;

async function dateOnSale(): Promise<string> {
  dates += 1;
  const dateId = `01a0fc00-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await putOnSale(app.get(CommandBus), { dateId, channelId: CHANNEL, capacity: 10 }, NOW);
  return dateId;
}

function purchaseBody(dateId: string, overrides: object = {}): object {
  return {
    dateId,
    tier: PriceTier.FULL,
    quantity: 2,
    expectedTotal: { amountMinor: FULL_PRICE_MINOR * 2, currencyCode: 'EUR' },
    ...overrides,
  };
}

function postPurchase(payload: object, key: string | null = nextKey()) {
  return app.inject({
    method: 'POST',
    url: '/v1/orders/seats',
    headers: {
      'content-type': 'application/json',
      ...(key !== null && { 'idempotency-key': key }),
    },
    payload,
  });
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_orders_http_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  const clock = new FixedClock(NOW);
  fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  app = await httpApp({
    imports: [OrdersModule, DateSalesModule, CatalogFactsModule],
    providers: EDGE_PROVIDERS,
    dataSource,
    overrides: [
      [CLOCK, clock],
      [FakePaymentProvider, fake],
      [PUBLIC_WEB_ORIGIN, 'http://storefront.test'],
    ],
  });
}, STARTUP_MS);

beforeEach(() => {
  fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
});

afterAll(async () => {
  await app?.close();
  await stack?.stop();
});

describe('POST /v1/dates/:dateId/seat-quote', () => {
  it(
    'answers the contract’s SeatQuote, and requires the deadline',
    async () => {
      const dateId = await dateOnSale();

      const quote = await app.inject({
        method: 'POST',
        url: `/v1/dates/${dateId}/seat-quote`,
        headers: { 'content-type': 'application/json', 'x-arthome-deadline': DEADLINE },
        payload: { tier: PriceTier.FULL, quantity: 2 },
      });

      expect(quote.statusCode).toBe(200);
      expect(quote.headers['cache-control']).toBe('no-store');
      expect(SeatQuoteSchema.parse(quote.json<{ data: unknown }>().data)).toMatchObject({
        total: { amountMinor: 4800, currencyCode: 'EUR' },
      });
      const undated = await app.inject({
        method: 'POST',
        url: `/v1/dates/${dateId}/seat-quote`,
        headers: { 'content-type': 'application/json' },
        payload: { tier: PriceTier.FULL, quantity: 2 },
      });
      expect(undated.statusCode).toBe(400);
    },
    CASE_MS,
  );
});

describe('POST /v1/orders/seats', () => {
  it(
    'answers 201 with the contract’s tickets and order, and replays them with its header',
    async () => {
      const dateId = await dateOnSale();
      const key = nextKey();

      const paid = await postPurchase(purchaseBody(dateId), key);

      expect(paid.statusCode).toBe(201);
      const { data } = paid.json<{ data: { tickets: unknown[]; order: unknown } }>();
      expect(data.tickets.map((ticket) => TicketWithoutDateSchema.parse(ticket))).toHaveLength(2);
      expect(OrderSchema.parse(data.order)).toMatchObject({
        kind: OrderKind.SEAT,
        state: OrderState.PAID,
      });

      const replay = await postPurchase(purchaseBody(dateId), key);
      expect(replay.statusCode).toBe(201);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.body).toBe(paid.body);
    },
    CASE_MS,
  );

  it(
    'answers 202 with the contract’s PaymentHandoff while the buyer has to act',
    async () => {
      const dateId = await dateOnSale();
      fake.scenarioOf = () => FakePaymentScenario.REQUIRE_ACTION;

      const awaiting = await postPurchase(purchaseBody(dateId));

      expect(awaiting.statusCode).toBe(202);
      const handoff = PaymentHandoffSchema.parse(awaiting.json<{ data: unknown }>().data);
      const order = await app.inject({
        method: 'GET',
        url: `/v1/orders/${handoff.orderId}`,
        headers: { 'x-arthome-deadline': DEADLINE },
      });
      expect(order.statusCode).toBe(200);
      expect(order.headers['cache-control']).toBe('no-store');
      const detail = order.json<{ data: { order: unknown; handoff: unknown } }>().data;
      expect(OrderSchema.parse(detail.order)).toMatchObject({
        state: OrderState.AWAITING_ACTION,
      });
      expect(PaymentHandoffSchema.parse(detail.handoff)).toEqual(handoff);
    },
    CASE_MS,
  );

  it(
    'refuses a body without its key, a contribution it has no rule for, and a stale price',
    async () => {
      const dateId = await dateOnSale();

      const keyless = await postPurchase(purchaseBody(dateId), null);
      expect(keyless.statusCode).toBe(400);
      expect(keyless.json()).toMatchObject({
        error: { code: ApiErrorCode.SCHEMA_INVALID, params: { fields: ['Idempotency-Key'] } },
      });

      const contribution = await postPurchase(purchaseBody(dateId, { contributionMinor: 500 }));
      expect(contribution.statusCode).toBe(400);
      expect(contribution.json()).toMatchObject({
        error: { params: { fields: ['contributionMinor'] } },
      });

      const stale = await postPurchase(
        purchaseBody(dateId, { expectedTotal: { amountMinor: 1, currencyCode: 'EUR' } }),
      );
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: { code: OrderErrorCode.PRICE_STALE } });
    },
    CASE_MS,
  );

  it(
    'answers 503 when the provider does not answer',
    async () => {
      const dateId = await dateOnSale();
      fake.scenarioOf = () => FakePaymentScenario.UNAVAILABLE;

      const unavailable = await postPurchase(purchaseBody(dateId));

      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toMatchObject({
        error: { code: ApiErrorCode.SERVICE_UNAVAILABLE, nature: FailureNature.UNAVAILABLE },
      });
    },
    CASE_MS,
  );
});
