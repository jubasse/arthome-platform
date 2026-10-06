import { successSchemaOf } from '@arthome-platform/http-edge';
import {
  applyMigrations,
  createDatabase,
  httpApp,
  mintInternalToken,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { CommandBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { studioApi } from '@arthome/contracts/studio-api';
import { OrderSchema, TicketCardSchema } from '@arthome/contracts/ticketing';
import {
  ApiErrorCode,
  FixedClock,
  OrderState,
  PriceTier,
  RefundDelayCode,
  RefundMethod,
  RefundReason,
  SeatCancelReason,
  SeatState,
  Service,
  money,
} from '@arthome/core';

import { SeatsModule } from './seats.module.js';
import { CLOCK } from '../clock.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { FULL_PRICE_MINOR, ITEST_BUYER_ACCOUNT_ID, nextKey, putOnSale } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ApplyPaymentEvents } from '../payments/apply-payment-events.command.js';
import { FakePaymentProvider, intentRefOf } from '../payments/fake-payment-provider.js';
import { PaymentWebhooksModule } from '../payments/payment-webhooks.module.js';
import { PaymentWorker } from '../payments/payment-worker.js';
import { PaymentWorkerModule } from '../payments/payment-worker.module.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/**
 * `cancelSeat` and `refundSeat` through the module graph the API boots, over HTTP, the answers
 *   parsed by the contract's own schemas; `TicketCard` without the `date` the BFF adds. What each
 *   decides is `cancel-seat.itest.ts`'s and `refund-seat.itest.ts`'s.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const NOW = '2026-10-06T10:00:00.000Z';
const DEADLINE = '2026-10-06T11:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const CHANNEL = '01a0fa1c-0000-7000-8000-000000000001';

const TicketWithoutDateSchema = TicketCardSchema.omit({ date: true });
const SeatRefundAnswerSchema = successSchemaOf(studioApi.routes.refundSeat);

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let clock: FixedClock;
let fake: FakePaymentProvider;
let dates = 0;

interface Bought {
  readonly orderId: string;
  readonly seatIds: readonly string[];
}

async function bought(quantity: number): Promise<Bought> {
  dates += 1;
  const dateId = `01a0fa10-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await putOnSale(
    app.get(CommandBus),
    { dateId, channelId: CHANNEL, capacity: 5, startsAt: STARTS_AT },
    NOW,
  );
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
  expect(answer.statusCode).toBe(201);
  const { data } = answer.json<{
    data: { order: { id: string }; tickets: { seatId: string }[] };
  }>();
  return { orderId: data.order.id, seatIds: data.tickets.map(({ seatId }) => seatId) };
}

function postCancel(seatId: string, payload?: object, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: `/v1/seats/${seatId}/cancel`,
    headers: {
      'idempotency-key': nextKey(),
      ...(payload !== undefined && { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(payload !== undefined && { payload }),
  });
}

function postRefund(seatId: string, payload: object, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: `/v1/seats/${seatId}/refund`,
    headers: { 'content-type': 'application/json', 'idempotency-key': nextKey(), ...headers },
    payload,
  });
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_seats_http_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock(NOW);
  fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  app = await httpApp({
    imports: [
      OrdersModule,
      SeatsModule,
      PaymentWebhooksModule,
      PaymentWorkerModule,
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
    ],
  });
}, STARTUP_MS);

afterAll(async () => {
  await app?.close();
  await stack?.stop();
});

describe('POST /v1/seats/:seatId/cancel', () => {
  it(
    'answers the contract’s TicketCard, cancelled with its refund, with or without a body',
    async () => {
      const { orderId, seatIds } = await bought(2);

      const withBody = await postCancel(seatIds[0] ?? '', {
        cancelReasonCode: SeatCancelReason.VIEWER_REQUEST,
      });
      const withoutBody = await postCancel(seatIds[1] ?? '');

      expect(withBody.statusCode).toBe(200);
      expect(withBody.headers['cache-control']).toBe('no-store');
      const { data } = withBody.json<{ data: { ticket: unknown } }>();
      expect(TicketWithoutDateSchema.parse(data.ticket)).toMatchObject({
        seatId: seatIds[0],
        orderId,
        state: SeatState.CANCELLED,
        refund: {
          amount: money(2400, 'EUR'),
          delayCode: RefundDelayCode.BUSINESS_DAYS_3_5,
          method: RefundMethod.ORIGINAL_PAYMENT_METHOD,
          refundReasonCode: RefundReason.VIEWER_REQUEST,
        },
      });
      expect(withoutBody.statusCode).toBe(200);
    },
    CASE_MS,
  );

  it(
    'replays under its key with Idempotency-Replayed, byte for byte',
    async () => {
      const { seatIds } = await bought(1);
      const key = nextKey();

      const first = await postCancel(seatIds[0] ?? '', {}, { 'idempotency-key': key });
      const replay = await postCancel(seatIds[0] ?? '', {}, { 'idempotency-key': key });

      expect(replay.statusCode).toBe(200);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.body).toBe(first.body);
    },
    CASE_MS,
  );

  it(
    'refuses a call naming no account 401, a malformed body and a missing key 400',
    async () => {
      const { seatIds } = await bought(1);
      const seatId = seatIds[0] ?? '';

      const anonymous = await postCancel(
        seatId,
        {},
        {
          authorization: `Bearer ${await mintInternalToken({ service: Service.TICKETING, clock })}`,
        },
      );
      const unknownField = await postCancel(seatId, {
        cancelReasonCode: SeatCancelReason.DATE_CANCELLED,
      });
      const extra = await postCancel(seatId, { because: 'no' });
      const keyless = await app.inject({ method: 'POST', url: `/v1/seats/${seatId}/cancel` });

      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json()).toMatchObject({ error: { code: ApiErrorCode.UNAUTHENTICATED } });
      for (const refused of [unknownField, extra, keyless]) {
        expect(refused.statusCode).toBe(400);
        expect(refused.json()).toMatchObject({ error: { code: ApiErrorCode.SCHEMA_INVALID } });
      }
    },
    CASE_MS,
  );
});

describe('POST /v1/seats/:seatId/refund', () => {
  it(
    'answers the contract’s SeatRefund: the amount, no payout, no commission yet',
    async () => {
      const { seatIds } = await bought(2);

      const answer = await postRefund(
        seatIds[0] ?? '',
        { refundReasonCode: RefundReason.GOODWILL, partialAmountMinor: 700 },
        { 'if-rights-version': '412' },
      );

      expect(answer.statusCode).toBe(200);
      expect(answer.headers['cache-control']).toBe('no-store');
      // The studio's envelope carries the operator's rights version, which auth slice B stamps.
      const parsed = SeatRefundAnswerSchema.parse({ ...answer.json<object>(), rightsVersion: 412 });
      expect(parsed).toMatchObject({ data: { refunded: money(700, 'EUR'), payoutId: null } });
      expect(answer.json<{ data: object }>().data).not.toHaveProperty('commissionRefunded');
    },
    CASE_MS,
  );

  it(
    'refuses a malformed If-Rights-Version and a malformed body 400, naming them',
    async () => {
      const { seatIds } = await bought(1);
      const seatId = seatIds[0] ?? '';

      const version = await postRefund(
        seatId,
        { refundReasonCode: RefundReason.GOODWILL },
        { 'if-rights-version': 'v3' },
      );
      const reason = await postRefund(seatId, { refundReasonCode: RefundReason.VIEWER_REQUEST });
      const amount = await postRefund(seatId, {
        refundReasonCode: RefundReason.DUPLICATE,
        partialAmountMinor: 0,
      });

      expect(version.statusCode).toBe(400);
      expect(JSON.stringify(version.json())).toContain('If-Rights-Version');
      for (const refused of [reason, amount]) {
        expect(refused.statusCode).toBe(400);
        expect(refused.json()).toMatchObject({ error: { code: ApiErrorCode.SCHEMA_INVALID } });
      }
    },
    CASE_MS,
  );
});

describe('GET /v1/orders/:orderId once a seat is refunded', () => {
  it(
    'serves the ticket’s refund and the order’s refundReasonCode',
    async () => {
      const { orderId, seatIds } = await bought(2);
      await postCancel(seatIds[0] ?? '');
      const [owed] = await dataSource.query<{ amount_minor: string; idempotency_key: string }[]>(
        'SELECT amount_minor, idempotency_key FROM order_refund WHERE order_id = $1',
        [orderId],
      );
      const { refundRef } = await fake.refund({
        intentRef: intentRefOf(orderId),
        amount: money(Number(owed?.amount_minor), 'EUR'),
        idempotencyKey: owed?.idempotency_key ?? '',
        refundApplicationFee: true,
      });
      const { body, signature } = fake.refundSucceededWebhookOf(refundRef);
      await app.inject({
        method: 'POST',
        url: '/v1/payments/webhook',
        headers: { 'content-type': 'application/json', [fake.signatureHeader]: signature },
        payload: body,
      });
      await app.get(CommandBus).execute(new ApplyPaymentEvents(100));

      const read = await app.inject({
        method: 'GET',
        url: `/v1/orders/${orderId}`,
        headers: { 'x-arthome-deadline': DEADLINE },
      });

      expect(read.statusCode).toBe(200);
      const { data } = read.json<{ data: { order: unknown; tickets: unknown[] } }>();
      expect(OrderSchema.parse(data.order)).toMatchObject({
        state: OrderState.PARTIALLY_REFUNDED,
        refundReasonCode: RefundReason.VIEWER_REQUEST,
      });
      const tickets = data.tickets.map((ticket) => TicketWithoutDateSchema.parse(ticket));
      expect(tickets.find(({ seatId }) => seatId === seatIds[0])).toMatchObject({
        state: SeatState.REFUNDED,
        refund: { amount: money(2400, 'EUR'), refundReasonCode: RefundReason.VIEWER_REQUEST },
      });
      expect(tickets.find(({ seatId }) => seatId === seatIds[1])).toMatchObject({
        state: SeatState.ACTIVE,
        refund: null,
      });
    },
    CASE_MS,
  );
});
