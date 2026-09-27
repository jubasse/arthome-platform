import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ApiErrorCode,
  DisplayState,
  FailureNature,
  ReplayPolicy,
  RightsScope,
  Surface,
} from '@arthome/core';

import { AppModule } from '../app.module.js';
import { CATALOG_URL } from '../catalog/catalog.client.js';
import { answerNotModified } from '../conditional-get.js';

const DATE_ID = '01a0e700-0000-7000-8000-000000000001';
const HEADERS = { 'x-arthome-surface': Surface.STOREFRONT_WEB };

const CARD = {
  id: DATE_ID,
  showId: '01a0e700-0000-7000-8000-0000000000a1',
  channelId: 'channel-1',
  slug: '2026-11-04',
  canonicalUrl: 'https://arthome.test/show/nuit-blanche/date/2026-11-04',
  title: 'Nuit blanche',
  startsAt: '2026-11-04T19:30:00.000Z',
  venueClock: { venueTimezone: 'Europe/Paris', venueUtcOffsetMin: 60 },
  runtimeMin: 95,
  displayState: DisplayState.SCHEDULED,
  displayStateValidUntil: '2026-11-04T19:00:00.000Z',
  replay: { policy: ReplayPolicy.INCLUDED, windowHours: 72 },
  rights: { scope: RightsScope.WORLDWIDE },
  media: { wide: [], poster: [] },
};

let catalogAnswer: { status: number; body: object } = { status: 200, body: {} };
let catalogUrl = '';
let catalog: Server;
let app: NestFastifyApplication;

beforeAll(async () => {
  catalog = createServer((request, response) => {
    catalogUrl = request.url ?? '';
    response.writeHead(catalogAnswer.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(catalogAnswer.body));
  });
  await new Promise<void>((resolve) => catalog.listen(0, resolve));

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CATALOG_URL)
    .useValue(`http://localhost:${(catalog.address() as AddressInfo).port}`)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  answerNotModified(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  // Measured: under the full verify's parallel load, the first call through a cold app took
  // longer than the 200 ms search budget, and the case read a 504 instead of the page.
  await app.inject({
    method: 'GET',
    url: '/v1/search',
    headers: { 'x-arthome-surface': Surface.STOREFRONT_WEB },
  });
});

beforeEach(() => {
  catalogAnswer = {
    status: 200,
    body: {
      servedAt: '2026-09-27T10:00:00.000Z',
      validUntil: '2026-11-04T19:00:00.000Z',
      data: { ...CARD, totalSeriesDates: 0, seriesDates: [] },
    },
  };
});

afterAll(async () => {
  await app?.close();
  catalog.closeAllConnections();
  await new Promise((resolve) => catalog.close(resolve));
});

describe('GET /v1/dates/:dateId on the storefront BFF', () => {
  it('serves the page with a validator, and a 304 with no body when the surface holds it', async () => {
    const first = await app.inject({
      method: 'GET',
      url: `/v1/dates/${DATE_ID}`,
      headers: HEADERS,
    });
    const etag = String(first.headers.etag);
    const again = await app.inject({
      method: 'GET',
      url: `/v1/dates/${DATE_ID}`,
      headers: { ...HEADERS, 'if-none-match': etag },
    });

    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('public, max-age=60');
    expect(first.json()).toMatchObject({
      validUntil: '2026-11-04T19:00:00.000Z',
      data: { id: DATE_ID },
    });
    expect(etag).toMatch(/^W\/"/);
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });

  it('relays catalog’s 404 for a date that is not public', async () => {
    catalogAnswer = {
      status: 404,
      body: {
        error: {
          code: ApiErrorCode.NOT_FOUND,
          nature: FailureNature.REFUSED,
          params: {},
          traceId: 'a'.repeat(32),
        },
        servedAt: '2026-09-27T10:00:00.000Z',
      },
    };
    const response = await app.inject({
      method: 'GET',
      url: `/v1/dates/${DATE_ID}`,
      headers: HEADERS,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: ApiErrorCode.NOT_FOUND } });
  });

  it('refuses an identifier that is not one, before calling catalog', async () => {
    catalogUrl = '';
    const response = await app.inject({
      method: 'GET',
      url: '/v1/dates/not-a-date',
      headers: HEADERS,
    });

    expect(response.statusCode).toBe(400);
    expect(catalogUrl).toBe('');
  });
});

describe('GET /v1/resolve on the storefront BFF', () => {
  it('passes the link to catalog and serves what it resolved to', async () => {
    catalogAnswer = {
      status: 200,
      body: {
        servedAt: '2026-09-27T10:00:00.000Z',
        data: { kind: 'date', id: DATE_ID, canonicalUrl: CARD.canonicalUrl, date: CARD },
      },
    };
    const response = await app.inject({
      method: 'GET',
      url: '/v1/resolve',
      query: { url: CARD.canonicalUrl },
      headers: HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.json()).toMatchObject({
      data: { id: DATE_ID, canonicalUrl: CARD.canonicalUrl },
    });
    expect(catalogUrl).toBe(`/v1/resolve?url=${encodeURIComponent(CARD.canonicalUrl)}`);
  });

  it('refuses what is not a URL, naming the field', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/resolve',
      query: { url: 'nuit-blanche' },
      headers: HEADERS,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { params: { fields: ['url'] } } });
  });
});

describe('GET /v1/artists/:artistId on the storefront BFF', () => {
  it('serves the artist page catalog composed, cacheable for five minutes', async () => {
    const artistId = '01a0e700-0000-7000-8000-0000000000b1';
    catalogAnswer = {
      status: 200,
      body: {
        servedAt: '2026-09-27T10:00:00.000Z',
        validUntil: '2026-11-04T19:00:00.000Z',
        data: {
          id: artistId,
          channelId: 'channel-1',
          name: 'Compagnie Verticale',
          slug: 'compagnie-verticale',
          categoryId: 'theatre',
          joinedAt: '2026-09-27T09:00:00.000Z',
          upcomingDates: [CARD],
          pastDates: [],
          replays: [],
        },
      },
    };
    const response = await app.inject({
      method: 'GET',
      url: `/v1/artists/${artistId}`,
      headers: HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.json()).toMatchObject({ data: { name: 'Compagnie Verticale' } });
    expect(catalogUrl).toBe(`/v1/artists/${artistId}`);
  });
});
