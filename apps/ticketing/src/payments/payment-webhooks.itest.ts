import { OrderRefundedSchema, RefundReason as WireRefundReason } from '@arthome-platform/events';
import { OutboxEvent, RETRY_DELAYS_MS } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  httpApp,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiErrorCode,
  FixedClock,
  MINUTE_MS,
  OrderErrorCode,
  PriceTier,
  RefundReason,
  OrderState,
  PaymentEventKind,
} from '@arthome/core';

import { ApplyPaymentEvents } from './apply-payment-events.command.js';
import { CancelOwedIntents } from './cancel-owed-intents.command.js';
import {
  FakePaymentProvider,
  FakePaymentScenario,
  intentRefOf,
  type SignedWebhook,
} from './fake-payment-provider.js';
import { OWED_REFUND, REFUND_GIVE_UP_AFTER_MS, attemptsMaxOf } from './owed-calls.js';
import { refundKeyOf } from './owed-refunds.js';
import { PaymentWebhooksModule } from './payment-webhooks.module.js';
import { PaymentWorker } from './payment-worker.js';
import { PaymentWorkerModule } from './payment-worker.module.js';
import { RefundOwedPayments } from './refund-owed-payments.command.js';
import { CLOCK } from '../clock.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { FULL_PRICE_MINOR, nextKey, purchaseOf, putOnSale } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { ExpireDueHolds } from '../orders/expire-due-holds.command.js';
import { HoldExpirySweeper } from '../orders/hold-expiry-sweeper.js';
import { HoldExpiryModule } from '../orders/hold-expiry.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/**
 * adr-ticketing.md §7 and §8 over HTTP and against a real Postgres: a webhook verified on its bytes,
 *   recorded once, applied forward only by the payment worker's commands, run here by hand; and a
 *   payment confirmed after its hold expired, which takes the seats again or is refunded at once.
 *   Both loops are stubbed, so each pass is the suite's.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const DEADLINE_AHEAD_MS = 60 * MINUTE_MS;
const HOLD_MS = 15 * MINUTE_MS;
const CHANNEL = '01a0fe0c-0000-7000-8000-000000000001';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let clock: FixedClock;
let fake: FakePaymentProvider;
let dates = 0;

const commands = (): CommandBus => app.get(CommandBus);

async function dateOnSale(capacity = 10): Promise<string> {
  dates += 1;
  const dateId = `01a0fe00-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await putOnSale(commands(), { dateId, channelId: CHANNEL, capacity }, clock.now());
  return dateId;
}

/** A purchase answered 202: strong authentication awaited, its hold active. */
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

function deliver({ body, signature }: SignedWebhook, signatureHeader = fake.signatureHeader) {
  return app.inject({
    method: 'POST',
    url: '/v1/payments/webhook',
    headers: {
      'content-type': 'application/json',
      [signatureHeader]: signature,
      traceparent: TRACEPARENT,
    },
    payload: body,
  });
}

function applyEvents(): Promise<number> {
  return commands().execute(new ApplyPaymentEvents(100));
}

async function orderOf(orderId: string) {
  const answer = await app.inject({
    method: 'GET',
    url: `/v1/orders/${orderId}`,
    headers: { 'x-arthome-deadline': new Date(clock.nowMs() + DEADLINE_AHEAD_MS).toISOString() },
  });
  expect(answer.statusCode).toBe(200);
  return answer.json<{
    data: { order: { state: string; refundReasonCode?: string }; tickets: unknown[] };
  }>().data;
}

async function countersOf(
  dateId: string,
): Promise<{ seats_available: number; seats_sold: number }> {
  const [row] = await dataSource.query<{ seats_available: number; seats_sold: number }[]>(
    'SELECT seats_available, seats_sold FROM date_sales WHERE date_id = $1',
    [dateId],
  );
  if (row === undefined) throw new Error(`no date ${dateId}`);
  return row;
}

async function expireDueHolds(): Promise<void> {
  clock.advance(HOLD_MS);
  await commands().execute(new ExpireDueHolds());
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_payment_webhooks_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock('2026-09-28T10:00:00.000Z');
  fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  app = await httpApp({
    imports: [
      OrdersModule,
      PaymentWebhooksModule,
      PaymentWorkerModule,
      HoldExpiryModule,
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

describe('POST /v1/payments/webhook', () => {
  it(
    'records a confirmation at once, and the worker pays its order with its seats',
    async () => {
      const dateId = await dateOnSale();
      const orderId = await awaitingOrder(dateId);

      const received = await deliver(fake.completeAction(intentRefOf(orderId)));

      expect(received.statusCode).toBe(200);
      expect(received.json()).toMatchObject({ data: { duplicate: false } });
      expect((await orderOf(orderId)).order.state).toBe(OrderState.AWAITING_ACTION);

      expect(await applyEvents()).toBe(1);

      const paid = await orderOf(orderId);
      expect(paid.order.state).toBe(OrderState.PAID);
      expect(paid.tickets).toHaveLength(2);
      expect(await countersOf(dateId)).toEqual({ seats_available: 8, seats_sold: 2 });
      const rows = await dataSource.getRepository(OutboxEvent).findBy({ aggregateid: orderId });
      expect(rows.map(({ type, tracecontext }) => [type, tracecontext])).toEqual([
        ['ticketing.order.paid.v1', TRACEPARENT],
      ]);
    },
    CASE_MS,
  );

  it(
    'records a duplicate once and applies it once; a fact behind the order moves nothing',
    async () => {
      const dateId = await dateOnSale();
      const orderId = await awaitingOrder(dateId);
      const confirmation = fake.completeAction(intentRefOf(orderId));

      await deliver(confirmation);
      const again = await deliver(confirmation);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ data: { duplicate: true } });
      await applyEvents();
      await deliver(fake.webhookOf(intentRefOf(orderId), PaymentEventKind.INTENT_REQUIRES_ACTION));
      await deliver(fake.webhookOf(intentRefOf(orderId), PaymentEventKind.INTENT_FAILED));
      expect(await applyEvents()).toBe(2);

      expect((await orderOf(orderId)).order.state).toBe(OrderState.PAID);
      expect(await countersOf(dateId)).toEqual({ seats_available: 8, seats_sold: 2 });
      const paidRows = await dataSource
        .getRepository(OutboxEvent)
        .countBy({ aggregateid: orderId, type: 'ticketing.order.paid.v1' });
      expect(paidRows).toBe(1);
    },
    CASE_MS,
  );

  it(
    'refuses a signature over other bytes and records nothing; signed bytes that are no event, 400',
    async () => {
      const dateId = await dateOnSale();
      const orderId = await awaitingOrder(dateId);
      const genuine = fake.completeAction(intentRefOf(orderId));

      const forged = await deliver({
        body: Buffer.from(
          genuine.body.toString().replace('payment_intent.succeeded', 'payment_intent.canceled'),
        ),
        signature: genuine.signature,
      });
      expect(forged.statusCode).toBe(401);
      expect(forged.json()).toMatchObject({ error: { code: ApiErrorCode.UNAUTHENTICATED } });
      expect((await deliver(genuine, 'x-other-signature')).statusCode).toBe(401);

      const notAnEvent = Buffer.from('{"hello":"world"}');
      const unreadable = await deliver({
        body: notAnEvent,
        signature: fake.sign(notAnEvent, clock.now()),
      });
      expect(unreadable.statusCode).toBe(400);
      const [{ recorded }] = await dataSource.query<[{ recorded: number }]>(
        `SELECT count(*)::int AS recorded FROM stripe_event_inbox
          WHERE convert_from(payload, 'UTF8') LIKE ANY (ARRAY['%hello%', '%canceled%'])`,
      );
      expect(recorded).toBe(0);
    },
    CASE_MS,
  );

  it(
    'fails an order its payment failed, and gives its seats back',
    async () => {
      const dateId = await dateOnSale();
      const orderId = await awaitingOrder(dateId);

      await deliver(fake.failAction(intentRefOf(orderId)));
      await applyEvents();

      expect((await orderOf(orderId)).order.state).toBe(OrderState.FAILED);
      expect(await countersOf(dateId)).toEqual({ seats_available: 10, seats_sold: 0 });
    },
    CASE_MS,
  );

  it(
    'gives up at once on an event no order is known for, keeping its bytes',
    async () => {
      const unknownOrder = '01a0feee-0000-7000-8000-000000000001';
      const { ref } = await fake.createIntent({
        orderId: unknownOrder,
        amount: { amountMinor: 100, currencyCode: 'EUR' },
        expiresAt: clock.now(),
        returnUrl: 'http://storefront.test/orders/x',
      });
      const webhook = fake.webhookOf(ref, PaymentEventKind.INTENT_SUCCEEDED);

      await deliver(webhook);
      await applyEvents();

      const [row] = await dataSource.query<
        { dead_at: Date | null; attempts: number; payload: Buffer; last_error: string }[]
      >(
        'SELECT dead_at, attempts, payload, last_error FROM stripe_event_inbox WHERE order_id = $1',
        [unknownOrder],
      );
      expect(row?.dead_at).not.toBeNull();
      expect(row?.attempts).toBe(1);
      expect(row?.payload.equals(webhook.body)).toBe(true);
      expect(row?.last_error).toMatch(/no order/);
    },
    CASE_MS,
  );
});

describe('a payment confirmed after its hold expired (D-082)', () => {
  it(
    'takes the seats again with the conditional decrement when some are left',
    async () => {
      const dateId = await dateOnSale();
      const orderId = await awaitingOrder(dateId);
      await expireDueHolds();
      expect((await orderOf(orderId)).order.state).toBe(OrderState.FAILED);
      expect(await countersOf(dateId)).toEqual({ seats_available: 10, seats_sold: 0 });

      await deliver(fake.completeAction(intentRefOf(orderId)));
      await applyEvents();

      const paid = await orderOf(orderId);
      expect(paid.order.state).toBe(OrderState.PAID);
      expect(paid.tickets).toHaveLength(2);
      expect(await countersOf(dateId)).toEqual({ seats_available: 8, seats_sold: 2 });
      const [owed] = await dataSource.query<{ intent_cancel_owed_at: Date | null }[]>(
        'SELECT intent_cancel_owed_at FROM seat_order WHERE id = $1',
        [orderId],
      );
      expect(owed?.intent_cancel_owed_at).toBeNull();
    },
    CASE_MS,
  );

  it(
    'is refunded at once with none left: never oversold, never money kept without a seat',
    async () => {
      const dateId = await dateOnSale(2);
      const orderId = await awaitingOrder(dateId);
      await expireDueHolds();
      const other = await app.inject({
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
      expect(other.statusCode).toBe(201);
      const refundsBefore = fake.refundsMade;

      await deliver(fake.completeAction(intentRefOf(orderId)));
      await applyEvents();

      const refunded = await orderOf(orderId);
      expect(refunded.order).toMatchObject({
        state: OrderState.REFUNDED,
        refundReasonCode: RefundReason.HOLD_EXPIRED_CAPACITY_LOST,
      });
      expect(refunded.tickets).toEqual([]);
      expect(fake.refundsMade).toBe(refundsBefore + 1);
      expect(fake.calls).toContain(`refund ${refundKeyOf(orderId)}`);
      expect(await countersOf(dateId)).toEqual({ seats_available: 0, seats_sold: 2 });
      const [row] = await dataSource
        .getRepository(OutboxEvent)
        .findBy({ aggregateid: orderId, type: 'ticketing.order.refunded.v1' });
      expect(fromBinary(OrderRefundedSchema, row?.payload ?? new Uint8Array())).toMatchObject({
        orderId,
        amount: { amountMinor: 4800n, currencyCode: 'EUR' },
        refundReason: WireRefundReason.HOLD_EXPIRED_CAPACITY_LOST,
      });
    },
    CASE_MS,
  );

  it(
    'keeps the refund owed while the provider is down, and makes it once on a later pass',
    async () => {
      const dateId = await dateOnSale(2);
      const orderId = await awaitingOrder(dateId);
      await expireDueHolds();
      fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
      await commands().execute(purchaseOf(dateId, 2));
      const confirmation = fake.completeAction(intentRefOf(orderId));
      await deliver(confirmation);
      fake.down = true;

      await applyEvents();

      const [owed] = await dataSource.query<
        { state: string; refund_owed_at: Date | null; applied: boolean }[]
      >(
        `SELECT placed.state, placed.refund_owed_at, inbox.applied_at IS NOT NULL AS applied
           FROM seat_order AS placed JOIN stripe_event_inbox AS inbox ON inbox.order_id = placed.id
          WHERE placed.id = $1`,
        [orderId],
      );
      expect(owed).toMatchObject({ state: OrderState.FAILED, applied: true });
      expect(owed?.refund_owed_at).not.toBeNull();

      fake.down = false;
      const refundsBefore = fake.refundsMade;
      await commands().execute(new RefundOwedPayments(100));
      await commands().execute(new RefundOwedPayments(100));

      expect((await orderOf(orderId)).order.state).toBe(OrderState.REFUNDED);
      expect(fake.refundsMade).toBe(refundsBefore + 1);
      expect(
        await dataSource
          .getRepository(OutboxEvent)
          .countBy({ aggregateid: orderId, type: 'ticketing.order.refunded.v1' }),
      ).toBe(1);
    },
    CASE_MS,
  );

  it(
    'answers a purchase resumed past its hold sold out, and asks the provider nothing',
    async () => {
      const dateId = await dateOnSale();
      const key = nextKey();
      fake.scenarioOf = () => {
        throw new Error('the process died before tx B');
      };
      const payload = {
        dateId,
        tier: PriceTier.FULL,
        quantity: 2,
        expectedTotal: { amountMinor: FULL_PRICE_MINOR * 2, currencyCode: 'EUR' },
      };
      const post = () =>
        app.inject({
          method: 'POST',
          url: '/v1/orders/seats',
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          payload,
        });
      expect((await post()).statusCode).toBe(500);
      await expireDueHolds();
      fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
      const calls = fake.calls.length;

      const resumed = await post();

      expect(resumed.statusCode).toBe(409);
      expect(resumed.json()).toMatchObject({ error: { code: OrderErrorCode.SOLD_OUT } });
      expect(fake.calls).toHaveLength(calls);
      expect(await countersOf(dateId)).toEqual({ seats_available: 10, seats_sold: 0 });
    },
    CASE_MS,
  );
});

describe('the intent of an order whose hold expired (adr-ticketing.md §6)', () => {
  it(
    'is cancelled at the provider, best effort, and asked again while the provider is down',
    async () => {
      const dateId = await dateOnSale();
      const orderId = await awaitingOrder(dateId);
      await expireDueHolds();
      fake.down = true;

      await commands().execute(new CancelOwedIntents(100));

      const [stillOwed] = await dataSource.query<
        { intent_cancel_owed_at: Date | null; intent_cancel_next_attempt_at: Date }[]
      >(
        'SELECT intent_cancel_owed_at, intent_cancel_next_attempt_at FROM seat_order WHERE id = $1',
        [orderId],
      );
      expect(stillOwed?.intent_cancel_owed_at).toEqual(new Date(clock.nowMs()));
      const nextAttempt = stillOwed?.intent_cancel_next_attempt_at.getTime() ?? 0;
      expect(nextAttempt).toBeGreaterThanOrEqual(clock.nowMs() + 5_000);
      expect(nextAttempt).toBeLessThanOrEqual(clock.nowMs() + 6_000);

      fake.down = false;
      clock.advance(30_000);
      await commands().execute(new CancelOwedIntents(100));

      expect(fake.isCanceled(intentRefOf(orderId))).toBe(true);
      const [cancelled] = await dataSource.query<{ intent_cancel_owed_at: Date | null }[]>(
        'SELECT intent_cancel_owed_at FROM seat_order WHERE id = $1',
        [orderId],
      );
      expect(cancelled?.intent_cancel_owed_at).toBeNull();
    },
    CASE_MS,
  );

  it(
    'is owed again from its first instant when the provider says the intent still waits, its attempts started over',
    async () => {
      const dateId = await dateOnSale();
      const orderId = await awaitingOrder(dateId);
      await expireDueHolds();
      const owedAt = new Date(clock.nowMs());
      const cancellationOf = async () => {
        const [row] = await dataSource.query<
          {
            intent_cancel_owed_at: Date | null;
            intent_cancel_attempts: number;
            intent_cancel_next_attempt_at: Date | null;
            intent_cancel_dead_at: Date | null;
          }[]
        >(
          `SELECT intent_cancel_owed_at, intent_cancel_attempts, intent_cancel_next_attempt_at,
                  intent_cancel_dead_at
             FROM seat_order WHERE id = $1`,
          [orderId],
        );
        if (row === undefined) throw new Error(`no order ${orderId}`);
        return row;
      };
      const restarted = {
        intent_cancel_attempts: 0,
        intent_cancel_next_attempt_at: null,
        intent_cancel_dead_at: null,
      };
      fake.down = true;
      const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        for (let pass = 0; pass <= RETRY_DELAYS_MS.length; pass += 1) {
          await commands().execute(new CancelOwedIntents(100));
          const next = (await cancellationOf()).intent_cancel_next_attempt_at;
          if (next !== null) clock.advance(next.getTime() - clock.nowMs());
        }
      } finally {
        errors.mockRestore();
        fake.down = false;
      }
      expect((await cancellationOf()).intent_cancel_dead_at).not.toBeNull();

      clock.advance(MINUTE_MS);
      await deliver(fake.webhookOf(intentRefOf(orderId), PaymentEventKind.INTENT_REQUIRES_ACTION));
      await applyEvents();

      expect(await cancellationOf()).toEqual({ intent_cancel_owed_at: owedAt, ...restarted });

      await commands().execute(new CancelOwedIntents(100));
      expect(fake.isCanceled(intentRefOf(orderId))).toBe(true);
      expect(await cancellationOf()).toMatchObject({
        intent_cancel_owed_at: null,
        intent_cancel_attempts: 1,
      });

      clock.advance(MINUTE_MS);
      await deliver(fake.webhookOf(intentRefOf(orderId), PaymentEventKind.INTENT_PROCESSING));
      await applyEvents();

      expect(await cancellationOf()).toEqual({
        intent_cancel_owed_at: new Date(clock.nowMs()),
        ...restarted,
      });
    },
    CASE_MS,
  );
});

describe('a refund owed through a provider outage of hours (D-082, adr-ticketing.md §8)', () => {
  it(
    'is asked again for about a day, then given up on loudly, and made once an operator replays it',
    async () => {
      const dateId = await dateOnSale(2);
      const orderId = await awaitingOrder(dateId);
      await expireDueHolds();
      await commands().execute(purchaseOf(dateId, 2));
      await deliver(fake.completeAction(intentRefOf(orderId)));
      fake.down = true;
      await applyEvents();
      const owedAtMs = clock.nowMs();
      const scheduleOf = async () => {
        const [row] = await dataSource.query<
          {
            refund_attempts: number;
            refund_next_attempt_at: Date | null;
            refund_dead_at: Date | null;
          }[]
        >(
          `SELECT refund_attempts, refund_next_attempt_at, refund_dead_at FROM seat_order
            WHERE id = $1`,
          [orderId],
        );
        if (row === undefined) throw new Error(`no order ${orderId}`);
        return row;
      };
      const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        let passes = 0;
        for (;;) {
          await commands().execute(new RefundOwedPayments(100));
          passes += 1;
          const { refund_next_attempt_at: next, refund_dead_at: dead } = await scheduleOf();
          if (dead !== null || next === null || passes > attemptsMaxOf(OWED_REFUND)) break;
          clock.advance(next.getTime() - clock.nowMs());
        }

        const given = await scheduleOf();
        expect(passes).toBe(attemptsMaxOf(OWED_REFUND));
        expect(given.refund_attempts).toBe(attemptsMaxOf(OWED_REFUND));
        expect(given.refund_dead_at?.getTime()).toBeGreaterThanOrEqual(
          owedAtMs + REFUND_GIVE_UP_AFTER_MS,
        );
        expect((await orderOf(orderId)).order.state).toBe(OrderState.FAILED);
        expect(
          errors.mock.calls.filter(([message]) =>
            String(message).includes(`order ${orderId} given up`),
          ),
        ).toEqual([[expect.stringContaining('money is held without a seat'), expect.anything()]]);
      } finally {
        errors.mockRestore();
        fake.down = false;
      }

      // HANDOVER §0k's replay, as an operator runs it.
      await dataSource.query(
        `UPDATE seat_order
            SET refund_dead_at = NULL, refund_attempts = 0, refund_next_attempt_at = NULL
          WHERE id = $1 AND refund_dead_at IS NOT NULL`,
        [orderId],
      );
      const refundsBefore = fake.refundsMade;
      await commands().execute(new RefundOwedPayments(100));
      await commands().execute(new RefundOwedPayments(100));

      expect((await orderOf(orderId)).order.state).toBe(OrderState.REFUNDED);
      expect(fake.refundsMade).toBe(refundsBefore + 1);
    },
    CASE_MS,
  );
});
