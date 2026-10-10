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

import { storefrontApi } from '@arthome/contracts/storefront-api';
import { studioApi } from '@arthome/contracts/studio-api';
import {
  ApiErrorCode,
  FixedClock,
  OrderErrorCode,
  PriceTier,
  Service,
  WaitlistEntryState,
  priorityUntilOf,
} from '@arthome/core';

import { WaitlistModule } from './waitlist.module.js';
import { CLOCK } from '../clock.js';
import { CatalogFactsModule } from '../date-sales/catalog-facts.module.js';
import { DateSalesModule } from '../date-sales/date-sales.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { FULL_PRICE_MINOR, ITEST_BUYER_ACCOUNT_ID, nextKey, putOnSale } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { accountOf } from '../itest/waitlist.js';
import { OrdersModule } from '../orders/orders.module.js';
import { FakePaymentProvider } from '../payments/fake-payment-provider.js';
import { PaymentWorker } from '../payments/payment-worker.js';
import { PaymentWorkerModule } from '../payments/payment-worker.module.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/**
 * The three waiting-list routes and the tier's answer through the module graph the API boots, over
 *   HTTP, each account by its own internal token, the answers parsed by the contract's schemas;
 *   `WaitlistRegistration` without the `date` the BFF adds.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const NOW = '2026-10-10T10:00:00.000Z';
const DEADLINE = '2026-10-10T11:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const CHANNEL = '01a0fc6c-0000-7000-8000-000000000001';
const SERIES = '01a0fc06';

const RegistrationAnswerSchema = successSchemaOf(storefrontApi.routes.joinWaitlist);
const ReadAnswerSchema = successSchemaOf(storefrontApi.routes.getWaitlistRegistration);
const DepartureAnswerSchema = successSchemaOf(storefrontApi.routes.leaveWaitlist);
const TierAnswerSchema = successSchemaOf(studioApi.routes.openCapacityTier);

let stack: StartedStack;
let app: NestFastifyApplication;
let dataSource: DataSource;
let clock: FixedClock;
let dates = 0;

async function tokenOf(accountId: string | null): Promise<string> {
  return `Bearer ${await mintInternalToken({
    service: Service.TICKETING,
    clock,
    ...(accountId !== null && { accountId }),
  })}`;
}

async function soldOutDate(): Promise<string> {
  dates += 1;
  const dateId = `01a0fc60-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await putOnSale(
    app.get(CommandBus),
    { dateId, channelId: CHANNEL, capacity: 2, startsAt: STARTS_AT },
    NOW,
  );
  const bought = await app.inject({
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
  expect(bought.statusCode).toBe(201);
  return dateId;
}

async function onList(method: 'PUT' | 'DELETE', dateId: string, accountId: string | null) {
  return app.inject({
    method,
    url: `/v1/dates/${dateId}/waitlist`,
    headers: { 'idempotency-key': nextKey(), authorization: await tokenOf(accountId) },
  });
}

async function read(dateId: string, accountId: string, deadline: string | null = DEADLINE) {
  return app.inject({
    method: 'GET',
    url: `/v1/dates/${dateId}/waitlist`,
    headers: {
      authorization: await tokenOf(accountId),
      ...(deadline !== null && { 'x-arthome-deadline': deadline }),
    },
  });
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_waitlist_http_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock(NOW);
  const fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  app = await httpApp({
    imports: [
      WaitlistModule,
      OrdersModule,
      PaymentWorkerModule,
      DateSalesModule,
      CatalogFactsModule,
    ],
    providers: EDGE_PROVIDERS,
    caller: { service: Service.TICKETING, clock, accountId: ITEST_BUYER_ACCOUNT_ID },
    dataSource,
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

describe('the waiting-list routes', () => {
  it(
    'join, read, notify through a tier, and leave, each account seeing its own registration',
    async () => {
      const dateId = await soldOutDate();
      const first = accountOf(SERIES, 1);
      const second = accountOf(SERIES, 2);

      const joined = await onList('PUT', dateId, first);
      expect(joined.statusCode).toBe(200);
      expect(joined.headers['cache-control']).toBe('no-store');
      expect(RegistrationAnswerSchema.parse(joined.json()).data).toMatchObject({
        joined: true,
        state: WaitlistEntryState.WAITING,
        rankDisclosed: false,
        rank: null,
        priorityWindowHours: 2,
        priorityUntil: null,
      });
      const stranger = await read(dateId, second);
      expect(stranger.headers['cache-control']).toBe('no-store');
      expect(ReadAnswerSchema.parse(stranger.json()).data).toMatchObject({
        joined: false,
        state: null,
      });

      const pane = await app.inject({ method: 'GET', url: `/v1/dates/${dateId}/panes/tickets` });
      const { version } = pane.json<{ data: { version: number } }>().data;
      const tier = await app.inject({
        method: 'POST',
        url: `/v1/dates/${dateId}/capacity-tiers`,
        headers: { 'content-type': 'application/json', 'idempotency-key': nextKey() },
        payload: { additionalCapacity: 3, expectedVersion: version, notifyWaitlist: true },
      });
      expect(tier.statusCode).toBe(200);
      // The studio's envelope carries the operator's rights version, which auth slice B stamps.
      const opening = TierAnswerSchema.parse({ ...tier.json<object>(), rightsVersion: 1 });
      expect(opening.data).toMatchObject({
        waitlistNotified: 1,
        priorityUntil: priorityUntilOf(NOW),
        sales: {
          seatsAvailable: 0,
          priorityPool: { seatsLeft: 3, priorityUntil: priorityUntilOf(NOW) },
        },
      });

      expect(ReadAnswerSchema.parse((await read(dateId, first)).json()).data).toMatchObject({
        joined: true,
        state: WaitlistEntryState.NOTIFIED,
        priorityUntil: priorityUntilOf(NOW),
        priorityPoolSeats: 3,
      });
      expect(ReadAnswerSchema.parse((await read(dateId, second)).json()).data).not.toHaveProperty(
        'priorityPoolSeats',
      );

      const left = await onList('DELETE', dateId, first);
      const again = await onList('DELETE', dateId, first);
      expect([left.statusCode, again.statusCode]).toEqual([200, 200]);
      expect(DepartureAnswerSchema.parse(left.json())?.data).toEqual({ joined: false });
      expect(DepartureAnswerSchema.parse(again.json())?.data).toEqual({ joined: false });
      expect(ReadAnswerSchema.parse((await read(dateId, first)).json()).data).toMatchObject({
        joined: false,
        state: WaitlistEntryState.LEFT,
        priorityUntil: null,
      });
    },
    CASE_MS,
  );

  it(
    'refuses a join while public seats remain, an unknown date, no account, and a read with no deadline',
    async () => {
      const dateId = `01a0fc60-0000-7000-8000-${String(999).padStart(12, '0')}`;
      const withSeats = '01a0fc60-0000-7000-8000-000000000998';
      await putOnSale(
        app.get(CommandBus),
        { dateId: withSeats, channelId: CHANNEL, capacity: 2, startsAt: STARTS_AT },
        NOW,
      );
      const account = accountOf(SERIES, 3);

      const notSoldOut = await onList('PUT', withSeats, account);
      expect(notSoldOut.statusCode).toBe(409);
      expect(notSoldOut.json()).toMatchObject({
        error: { code: OrderErrorCode.WAITLIST_NOT_SOLD_OUT },
      });
      for (const answer of [
        await onList('PUT', dateId, account),
        await onList('DELETE', dateId, account),
        await read(dateId, account),
      ]) {
        expect(answer.statusCode).toBe(404);
        expect(answer.json()).toMatchObject({ error: { code: ApiErrorCode.NOT_FOUND } });
      }
      expect((await onList('PUT', withSeats, null)).statusCode).toBe(401);
      expect((await read(withSeats, account, null)).statusCode).toBe(400);
    },
    CASE_MS,
  );
});
