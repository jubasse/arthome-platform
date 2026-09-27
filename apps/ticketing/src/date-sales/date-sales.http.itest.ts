import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { CommandBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DateSalesPaneSchema } from '@arthome/contracts/studio-money';
import {
  ApiErrorCode,
  CatalogErrorCode,
  DomainErrorCode,
  FailureNature,
  FixedClock,
  PriceTier,
} from '@arthome/core';

import { applyCatalogDateMessage } from './catalog-date-messages.js';
import { CatalogFactsModule } from './catalog-facts.module.js';
import { DateSalesModule } from './date-sales.module.js';
import { AvailabilityModule } from '../availability/availability.module.js';
import { delivered, drafted, engaged } from '../itest/catalog-messages.js';
import { httpApp } from '../itest/http-app.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';

/**
 * The routes through the module graph the API boots, over HTTP: a handler missing from its module,
 * a schema not bound or a bus the graph cannot resolve fails here, not at the first request in
 * production. What each command decides is `date-sales.itest.ts`'s.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const NOW = '2026-09-27T10:00:00.000Z';
const DEADLINE = '2026-09-27T11:00:00.000Z';
const CHANNEL = 'channel-http-itest';

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let keys = 0;
let dates = 0;

function nextKey(): string {
  keys += 1;
  return `01a0f4ff-0000-7000-8000-${String(keys).padStart(12, '0')}`;
}

async function openedDate(): Promise<string> {
  dates += 1;
  const dateId = `01a0f400-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await applyCatalogDateMessage(app.get(CommandBus), delivered(drafted(dateId, CHANNEL, NOW)));
  return dateId;
}

const PRICES = {
  tiers: [
    { tier: PriceTier.FULL, amountMinor: 2400, currencyCode: 'EUR', active: true },
    { tier: PriceTier.REDUCED, amountMinor: 1600, currencyCode: 'EUR', active: false },
  ],
};

function putPrices(dateId: string, payload: object, key: string | null = nextKey()) {
  return app.inject({
    method: 'PUT',
    url: `/v1/dates/${dateId}/prices`,
    headers: {
      'content-type': 'application/json',
      ...(key !== null && { 'idempotency-key': key }),
    },
    payload,
  });
}

function postTier(dateId: string, payload: object) {
  return app.inject({
    method: 'POST',
    url: `/v1/dates/${dateId}/capacity-tiers`,
    headers: { 'content-type': 'application/json', 'idempotency-key': nextKey() },
    payload,
  });
}

function getAvailability(dateId: string, deadline: string | null = DEADLINE) {
  return app.inject({
    method: 'GET',
    url: `/v1/dates/${dateId}/availability`,
    headers: deadline === null ? {} : { 'x-arthome-deadline': deadline },
  });
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_http_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  app = await httpApp({
    imports: [DateSalesModule, AvailabilityModule, CatalogFactsModule],
    clock: new FixedClock(NOW),
    dataSource,
  });
}, STARTUP_MS);

afterAll(async () => {
  await app?.close();
  await stack?.stop();
});

describe('PUT /v1/dates/:dateId/prices', () => {
  it(
    'answers the pane with the version at the envelope’s root, and replays it under its key',
    async () => {
      const dateId = await openedDate();
      const key = nextKey();

      const first = await putPrices(dateId, { expectedVersion: 1, ...PRICES }, key);
      const again = await putPrices(dateId, { expectedVersion: 1, ...PRICES }, key);

      expect(first.statusCode).toBe(200);
      expect(first.headers['cache-control']).toBe('no-store');
      const body = first.json<{ servedAt: string; version: number; data: unknown }>();
      expect(body).toMatchObject({ servedAt: NOW, version: 2, data: { dateId, version: 2 } });
      expect(DateSalesPaneSchema.safeParse(body.data).success).toBe(true);
      expect(again.statusCode).toBe(200);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.body).toBe(first.body);
    },
    CASE_MS,
  );

  it(
    'refuses by name a missing key, a tier twice, two currencies and a field it does not know',
    async () => {
      const dateId = await openedDate();
      const [full, reduced] = PRICES.tiers;

      const cases = [
        [putPrices(dateId, { expectedVersion: 1, ...PRICES }, null), ['Idempotency-Key']],
        [putPrices(dateId, { expectedVersion: 1, tiers: [full, full] }), ['tiers']],
        [
          putPrices(dateId, {
            expectedVersion: 1,
            tiers: [full, { ...reduced, currencyCode: 'CHF' }],
          }),
          ['tiers'],
        ],
        [putPrices(dateId, { expectedVersion: 1, ...PRICES, lockedAt: NOW }), []],
      ] as const;

      for (const [attempt, fields] of cases) {
        const response = await attempt;
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          error: {
            code: ApiErrorCode.SCHEMA_INVALID,
            ...(fields.length > 0 && { params: { fields } }),
          },
        });
      }
    },
    CASE_MS,
  );

  it(
    'answers 409 with the code for a stale version and for prices the sale locked',
    async () => {
      const dateId = await openedDate();
      await putPrices(dateId, { expectedVersion: 1, ...PRICES });

      const stale = await putPrices(dateId, { expectedVersion: 1, ...PRICES });
      await applyCatalogDateMessage(app.get(CommandBus), delivered(engaged(dateId, NOW)));
      const locked = await putPrices(dateId, { expectedVersion: 3, ...PRICES });

      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({
        error: {
          code: DomainErrorCode.STATE_CONFLICT,
          params: { version: 2 },
          nature: FailureNature.REFUSED,
        },
      });
      expect(locked.statusCode).toBe(409);
      expect(locked.json()).toMatchObject({
        error: { code: CatalogErrorCode.PRICES_LOCKED, params: { lockedAt: NOW } },
      });
    },
    CASE_MS,
  );
});

describe('POST /v1/dates/:dateId/capacity-tiers', () => {
  it(
    'opens a tier and answers the pane with nobody notified, and refuses a tier of nothing',
    async () => {
      const dateId = await openedDate();

      const opened = await postTier(dateId, { additionalCapacity: 120, expectedVersion: 1 });
      const empty = await postTier(dateId, { additionalCapacity: 0, expectedVersion: 2 });

      expect(opened.statusCode).toBe(200);
      expect(opened.json()).toMatchObject({
        version: 2,
        data: { sales: { capacityTotal: 120, seatsAvailable: 120 }, waitlistNotified: 0 },
      });
      expect(empty.statusCode).toBe(400);
      expect(empty.json()).toMatchObject({ error: { params: { fields: ['additionalCapacity'] } } });
    },
    CASE_MS,
  );
});

describe('GET /v1/dates/:dateId/panes/tickets', () => {
  it(
    'serves the pane, 404 for a date ticketing never opened, 400 for an id that is none',
    async () => {
      const dateId = await openedDate();

      const pane = await app.inject({ method: 'GET', url: `/v1/dates/${dateId}/panes/tickets` });
      const unknown = await app.inject({
        method: 'GET',
        url: '/v1/dates/01a0f4aa-0000-7000-8000-000000000001/panes/tickets',
      });
      const malformed = await app.inject({ method: 'GET', url: '/v1/dates/nope/panes/tickets' });

      expect(pane.statusCode).toBe(200);
      expect(pane.json()).toMatchObject({ data: { dateId, capacityTotal: 0, version: 1 } });
      expect(unknown.statusCode).toBe(404);
      expect(malformed.statusCode).toBe(400);
    },
    CASE_MS,
  );
});

describe('GET /v1/dates/:dateId/availability', () => {
  it(
    'serves the figures from the sale’s opening, valid 60 s, and requires a deadline',
    async () => {
      const dateId = await openedDate();
      await postTier(dateId, { additionalCapacity: 50, expectedVersion: 1 });
      await putPrices(dateId, { expectedVersion: 2, ...PRICES });

      const beforeOpening = await getAvailability(dateId);
      await applyCatalogDateMessage(app.get(CommandBus), delivered(engaged(dateId, NOW)));
      const served = await getAvailability(dateId);
      const withoutDeadline = await getAvailability(dateId, null);

      expect(beforeOpening.statusCode).toBe(404);
      expect(served.statusCode).toBe(200);
      expect(served.headers['cache-control']).toBe('no-store');
      expect(served.json()).toEqual({
        servedAt: NOW,
        validUntil: '2026-09-27T10:01:00.000Z',
        data: {
          seatsAvailable: 50,
          waitlistCount: 0,
          fillRateBps: 0,
          soldOut: false,
          priceTiers: [
            {
              tier: PriceTier.FULL,
              amount: { amountMinor: 2400, currencyCode: 'EUR' },
              active: true,
            },
            {
              tier: PriceTier.REDUCED,
              amount: { amountMinor: 1600, currencyCode: 'EUR' },
              active: false,
            },
          ],
        },
      });
      expect(withoutDeadline.statusCode).toBe(400);
      expect(withoutDeadline.json()).toMatchObject({
        error: { params: { fields: ['x-arthome-deadline'] } },
      });
    },
    CASE_MS,
  );
});
