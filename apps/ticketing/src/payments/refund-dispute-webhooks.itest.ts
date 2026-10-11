import { setTimeout as delay } from 'node:timers/promises';

import { OrderRefundedSchema } from '@arthome-platform/events';
import { OutboxEvent } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  httpApp,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { BullModule } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FixedClock,
  HOUR_MS,
  OrderState,
  PriceTier,
  SeatState,
  Service,
  money,
  type PaymentPort,
} from '@arthome/core';

import { ApplyPaymentEvents } from './apply-payment-events.command.js';
import {
  FakePaymentProvider,
  FakePaymentScenario,
  intentRefOf,
  type SignedWebhook,
} from './fake-payment-provider.js';
import { OwedCallRelay, ProviderCallProducer } from './owed-call-relay.js';
import { PaymentWebhooksModule } from './payment-webhooks.module.js';
import { PaymentWorker } from './payment-worker.js';
import { PaymentWorkerModule } from './payment-worker.module.js';
import {
  PROVIDER_CALL_SCHEDULES,
  REFUND_JOB,
  jobIdOf,
  type ProviderCallSchedules,
} from './provider-call-queues.js';
import { ProviderCallQueuesModule } from './provider-call-queues.module.js';
import { CLOCK } from '../clock.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import {
  FULL_PRICE_MINOR,
  ITEST_BUYER_ACCOUNT_ID,
  nextKey,
  purchaseOf,
  putOnSale,
  seatCancellationOf,
} from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import type { PurchasedSeats } from '../orders/order-views.js';
import { OrdersModule } from '../orders/orders.module.js';
import type { PurchaseAnswer } from '../orders/purchase-seat.command.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { SeatsModule } from '../seats/seats.module.js';

/**
 * The provider's refund and dispute webhooks (HANDOVER §0o) over HTTP with the raw body, applied by
 *   the payment worker, the worker's queues on a Redis of the file's own: a refund webhook marking
 *   nothing made but re-running the calls it may cover, one made outside the platform ignored, a
 *   dispute on a paid order and one before its confirmation, a refund on a disputed charge given
 *   up on, and duplicates applied once.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const PREFIX = '{ticketing-refund-dispute-webhooks-itest}';
const SHORT: ProviderCallSchedules = { refunds: [100, 200], intentCancellations: [100] };
const NOW = '2026-10-06T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const CHANNEL = '01a0fe0c-0000-7000-8000-000000000001';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let clock: FixedClock;
let fake: FakePaymentProvider;
let relay: OwedCallRelay;
let dates = 0;

const commands = (): CommandBus => app.get(CommandBus);

async function dateOnSale(capacity = 5): Promise<string> {
  dates += 1;
  const dateId = `01a0fe00-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await putOnSale(
    commands(),
    { dateId, channelId: CHANNEL, capacity, startsAt: STARTS_AT },
    clock.now(),
  );
  return dateId;
}

async function bought(dateId: string, quantity: number): Promise<PurchasedSeats> {
  const answer: PurchaseAnswer = await commands().execute(purchaseOf(dateId, quantity));
  return answer.response.envelope.data as PurchasedSeats;
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
    headers: {
      'content-type': 'application/json',
      [fake.signatureHeader]: signature,
      traceparent: TRACEPARENT,
    },
    payload: body,
  });
}

async function applyEvents(): Promise<void> {
  await commands().execute(new ApplyPaymentEvents(100));
}

interface RefundRow {
  readonly id: string;
  readonly idempotency_key: string;
  readonly amount_minor: string;
  readonly refund_ref: string | null;
  readonly refunded_at: Date | null;
  readonly rerun_asked_at: Date | null;
  readonly dead_at: Date | null;
}

function refundsOf(orderId: string): Promise<RefundRow[]> {
  return dataSource.query(
    `SELECT id, idempotency_key, amount_minor, refund_ref, refunded_at, rerun_asked_at, dead_at
       FROM order_refund WHERE order_id = $1 ORDER BY owed_at, id`,
    [orderId],
  );
}

async function orderOf(orderId: string) {
  const [row] = await dataSource.query<{ state: string; version: number }[]>(
    'SELECT state, version FROM seat_order WHERE id = $1',
    [orderId],
  );
  if (row === undefined) throw new Error(`no order ${orderId}`);
  return row;
}

function seatStatesOf(orderId: string): Promise<{ state: string }[]> {
  return dataSource.query('SELECT state FROM seat WHERE order_id = $1 ORDER BY id', [orderId]);
}

function outboxOf(aggregateId: string, type: string): Promise<OutboxEvent[]> {
  return dataSource.getRepository(OutboxEvent).find({
    where: { aggregateid: aggregateId, type },
    order: { created_at: 'ASC', id: 'ASC' },
  });
}

async function inboxOf(orderId: string) {
  return dataSource.query<{ kind: string; applied_at: Date | null; dead_at: Date | null }[]>(
    `SELECT kind, applied_at, dead_at FROM stripe_event_inbox
      WHERE order_id = $1 ORDER BY received_at, event_id`,
    [orderId],
  );
}

const providerCallsFor = (idempotencyKey: string): string[] =>
  fake.calls.filter((call) => call === `refund ${idempotencyKey}`);

async function until(what: string, ready: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await ready())) {
    if (performance.now() > deadline) throw new Error(`${what}, not within ${timeoutMs} ms`);
    await delay(50);
  }
}

/** What the provider made for a refund owed while its answer never reached the processor. */
async function madeAtTheProvider(orderId: string, refund: RefundRow): Promise<string> {
  const port: PaymentPort = fake;
  const { refundRef } = await port.refund({
    intentRef: intentRefOf(orderId),
    amount: money(Number(refund.amount_minor), 'EUR'),
    idempotencyKey: refund.idempotency_key,
    refundApplicationFee: true,
  });
  return refundRef;
}

/** Enqueued, its first call failed: its job waits an hour's backoff. */
async function waitingItsBackoff(refund: RefundRow): Promise<void> {
  await app
    .get(ProviderCallProducer)
    .refunds.add(
      REFUND_JOB,
      { refundId: refund.id },
      { jobId: jobIdOf(refund.idempotency_key), delay: HOUR_MS },
    );
  await dataSource.query('UPDATE order_refund SET enqueued_at = $2 WHERE id = $1', [
    refund.id,
    new Date(NOW),
  ]);
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, redis: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_refund_dispute_itest');
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
      BullModule.forRoot({ connection: { url: stack.redis.url }, prefix: PREFIX }),
      ProviderCallQueuesModule,
    ],
    providers: EDGE_PROVIDERS,
    caller: { service: Service.TICKETING, clock, accountId: ITEST_BUYER_ACCOUNT_ID },
    dataSource,
    rawBody: true,
    overrides: [
      [CLOCK, clock],
      [FakePaymentProvider, fake],
      [PUBLIC_WEB_ORIGIN, 'http://storefront.test'],
      [PROVIDER_CALL_SCHEDULES, SHORT],
      [PaymentWorker, {}],
      [OwedCallRelay, {}],
    ],
  });
  relay = new OwedCallRelay(dataSource, app.get(ProviderCallProducer), clock, SHORT);
}, STARTUP_MS);

beforeEach(() => {
  fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
});

afterAll(async () => {
  await app?.close();
  await stack?.stop();
});

describe('a refund the provider reports made (refund_succeeded)', () => {
  it(
    'marks nothing made, re-runs the call, and the processor marks it made with the answer, once',
    async () => {
      const dateId = await dateOnSale();
      const { order, tickets } = await bought(dateId, 2);
      await commands().execute(seatCancellationOf(tickets[0]?.seatId ?? ''));
      const [owed] = await refundsOf(order.id);
      if (owed === undefined) throw new Error('no refund owed');
      const madeBefore = fake.refundsMade;
      const refundRef = await madeAtTheProvider(order.id, owed);
      const webhook = fake.refundSucceededWebhookOf(refundRef);

      expect((await deliver(webhook)).statusCode).toBe(200);
      expect(await deliver(webhook)).toMatchObject({ statusCode: 200 });
      await applyEvents();

      expect(await refundsOf(order.id)).toMatchObject([
        { refund_ref: null, refunded_at: null, rerun_asked_at: new Date(NOW) },
      ]);
      expect(await outboxOf(order.id, 'ticketing.order.refunded.v1')).toEqual([]);

      await relay.relayDue();
      await until('the refund made', async () =>
        (await refundsOf(order.id)).every(({ refunded_at }) => refunded_at !== null),
      );
      await deliver(fake.refundSucceededWebhookOf(refundRef));
      await applyEvents();
      await relay.relayDue();

      expect(await refundsOf(order.id)).toMatchObject([
        { refund_ref: refundRef, rerun_asked_at: null, dead_at: null },
      ]);
      expect(await orderOf(order.id)).toMatchObject({ state: OrderState.PARTIALLY_REFUNDED });
      expect((await seatStatesOf(order.id)).map(({ state }) => state).sort()).toEqual(
        [SeatState.ACTIVE, SeatState.REFUNDED].sort(),
      );
      const refunded = (await outboxOf(order.id, 'ticketing.order.refunded.v1')).map((row) =>
        fromBinary(OrderRefundedSchema, row.payload),
      );
      expect(refunded).toMatchObject([{ refundRef }]);
      expect(await inboxOf(order.id)).toHaveLength(2);
      expect((await inboxOf(order.id)).every(({ applied_at }) => applied_at !== null)).toBe(true);
      expect(providerCallsFor(owed.idempotency_key)).toHaveLength(2);
      expect(fake.refundsMade).toBe(madeBefore + 1);
    },
    CASE_MS,
  );

  it(
    'marks nothing the provider did not make: two equal refunds, the newer made, the older run now',
    async () => {
      const dateId = await dateOnSale();
      const { order, tickets } = await bought(dateId, 2);
      await commands().execute(seatCancellationOf(tickets[0]?.seatId ?? ''));
      await commands().execute(seatCancellationOf(tickets[1]?.seatId ?? ''));
      const [older, newer] = await refundsOf(order.id);
      if (older === undefined || newer === undefined) throw new Error('two refunds not owed');
      expect(older.amount_minor).toBe(newer.amount_minor);
      await waitingItsBackoff(older);
      await waitingItsBackoff(newer);
      const madeBefore = fake.refundsMade;
      const newerRef = await madeAtTheProvider(order.id, newer);

      await deliver(fake.refundSucceededWebhookOf(newerRef));
      await applyEvents();

      expect(await refundsOf(order.id)).toMatchObject([
        { refunded_at: null, rerun_asked_at: new Date(NOW) },
        { refunded_at: null, rerun_asked_at: new Date(NOW) },
      ]);
      expect(await outboxOf(order.id, 'ticketing.order.refunded.v1')).toEqual([]);

      await relay.relayDue();
      await until('both refunds made, their backoff cleared', async () =>
        (await refundsOf(order.id)).every(({ refunded_at }) => refunded_at !== null),
      );

      const [olderMade, newerMade] = await refundsOf(order.id);
      expect(newerMade?.refund_ref).toBe(newerRef);
      expect(olderMade?.refund_ref).not.toBe(newerRef);
      expect(olderMade?.refund_ref).not.toBeNull();
      expect(providerCallsFor(older.idempotency_key)).toHaveLength(1);
      expect(providerCallsFor(newer.idempotency_key)).toHaveLength(2);
      expect(fake.refundsMade).toBe(madeBefore + 2);
      expect(await outboxOf(order.id, 'ticketing.order.refunded.v1')).toHaveLength(2);
      expect((await orderOf(order.id)).state).toBe(OrderState.REFUNDED);
    },
    CASE_MS,
  );

  it(
    'keeps and ignores a cumulative past every refund the order holds, a refund made elsewhere',
    async () => {
      const dateId = await dateOnSale();
      const { order } = await bought(dateId, 1);
      const before = await orderOf(order.id);
      const port: PaymentPort = fake;
      const { refundRef } = await port.refund({
        intentRef: intentRefOf(order.id),
        amount: money(1000, 'EUR'),
        idempotencyKey: 'refund:made-in-the-provider-dashboard',
        refundApplicationFee: true,
      });

      await deliver(fake.refundSucceededWebhookOf(refundRef));
      await applyEvents();

      expect(await inboxOf(order.id)).toMatchObject([{ dead_at: null }]);
      expect((await inboxOf(order.id))[0]?.applied_at).not.toBeNull();
      expect(await orderOf(order.id)).toEqual(before);
      expect(await outboxOf(order.id, 'ticketing.order.refunded.v1')).toEqual([]);
    },
    CASE_MS,
  );
});

describe('a dispute (dispute_opened)', () => {
  it(
    'marks a paid order disputed, its seats left active, nothing asked and nothing written',
    async () => {
      const dateId = await dateOnSale();
      const { order } = await bought(dateId, 2);
      const outboxBefore = await dataSource.getRepository(OutboxEvent).count();
      const callsBefore = fake.calls.length;
      const webhook = fake.disputeOpened(intentRefOf(order.id));

      await deliver(webhook);
      await deliver(webhook);
      await applyEvents();

      expect((await orderOf(order.id)).state).toBe(OrderState.DISPUTED);
      expect((await seatStatesOf(order.id)).map(({ state }) => state)).toEqual([
        SeatState.ACTIVE,
        SeatState.ACTIVE,
      ]);
      expect(fake.calls.slice(callsBefore)).toEqual([]);
      expect(await dataSource.getRepository(OutboxEvent).count()).toBe(outboxBefore);
      expect(await inboxOf(order.id)).toHaveLength(1);
    },
    CASE_MS,
  );

  it(
    'settles the payment of an order not yet paid, then marks it disputed',
    async () => {
      const dateId = await dateOnSale();
      const orderId = await awaitingOrder(dateId, 2);

      await deliver(fake.disputeOpened(intentRefOf(orderId)));
      await applyEvents();

      expect((await orderOf(orderId)).state).toBe(OrderState.DISPUTED);
      expect((await seatStatesOf(orderId)).map(({ state }) => state)).toEqual([
        SeatState.ACTIVE,
        SeatState.ACTIVE,
      ]);
      expect(await outboxOf(orderId, 'ticketing.order.paid.v1')).toHaveLength(1);
      expect(await outboxOf(dateId, 'ticketing.seat.activated.v1')).toHaveLength(2);
      const [counters] = await dataSource.query<{ seats_sold: number }[]>(
        'SELECT seats_sold FROM date_sales WHERE date_id = $1',
        [dateId],
      );
      expect(counters?.seats_sold).toBe(2);
    },
    CASE_MS,
  );

  it(
    'gives a refund owed before the dispute up at once, no provider call, not to be replayed',
    async () => {
      const dateId = await dateOnSale();
      const { order, tickets } = await bought(dateId, 2);
      await commands().execute(seatCancellationOf(tickets[0]?.seatId ?? ''));
      await deliver(fake.disputeOpened(intentRefOf(order.id)));
      await applyEvents();
      const [owed] = await refundsOf(order.id);
      if (owed === undefined) throw new Error('no refund owed');
      const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      try {
        await relay.relayDue();
        await until('the refund given up on', async () =>
          (await refundsOf(order.id)).every(({ dead_at }) => dead_at !== null),
        );
        expect(errors.mock.calls.filter(([message]) => String(message).includes(owed.id))).toEqual([
          [
            expect.stringContaining('do not replay the refund while the dispute is open'),
            undefined,
          ],
        ]);
      } finally {
        errors.mockRestore();
      }

      expect(await refundsOf(order.id)).toMatchObject([{ refunded_at: null }]);
      expect(providerCallsFor(owed.idempotency_key)).toEqual([]);
      expect((await orderOf(order.id)).state).toBe(OrderState.DISPUTED);
    },
    CASE_MS,
  );
});
