import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiErrorCode, FailureNature, Surface } from '@arthome/core';

import { AppModule } from '../app.module.js';
import { CATALOG_URL } from '../catalog/catalog.client.js';

/** The BFF as a surface meets it, with a stand-in catalog behind it. */

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

const PAGE = {
  groups: [],
  facets: [{ facetId: 'category', values: [] }],
  page: { hasMore: false },
};

let catalogAnswer: { status: number; body: object } = { status: 200, body: {} };
let catalogSaw: { url: string; headers: IncomingHttpHeaders } | null = null;
let catalog: Server;
let app: NestFastifyApplication;

async function search(
  query: Record<string, string>,
  headers: Record<string, string> = { 'x-arthome-surface': Surface.STOREFRONT_TV },
) {
  return app.inject({ method: 'GET', url: '/v1/search', query, headers });
}

beforeAll(async () => {
  catalog = createServer((request, response) => {
    catalogSaw = { url: request.url ?? '', headers: request.headers };
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
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

beforeEach(() => {
  catalogSaw = null;
  catalogAnswer = {
    status: 200,
    body: { servedAt: '2026-09-26T20:00:00.000Z', validUntil: '2026-09-26T20:30:00.000Z', ...PAGE },
  };
});

afterAll(async () => {
  await app?.close();
  catalog.closeAllConnections();
  await new Promise((resolve) => catalog.close(resolve));
});

describe('GET /v1/search on the storefront BFF', () => {
  it('serves catalog’s page in its own envelope, cacheable by anyone', async () => {
    const response = await search({ q: 'nuit', genreIds: 'dance' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    expect(response.headers.vary).toContain('X-Arthome-Surface');
    expect(response.json()).toMatchObject({ validUntil: '2026-09-26T20:30:00.000Z', ...PAGE });
    expect(catalogSaw?.url).toBe('/v1/search?q=nuit&genreIds=dance');
  });

  it('gives catalog a deadline 200 ms out, and a trace when the surface sent none', async () => {
    const before = Date.now();
    await search({ q: 'nuit' });

    const deadline = Date.parse(String(catalogSaw?.headers['x-arthome-deadline']));
    expect(deadline - before).toBeGreaterThanOrEqual(200);
    expect(deadline - before).toBeLessThan(400);
    expect(catalogSaw?.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('refuses a caller that is not a storefront surface, before calling catalog', async () => {
    for (const headers of [{}, { 'x-arthome-surface': Surface.STUDIO_WEB }]) {
      const response = await search({ q: 'nuit' }, headers);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: ApiErrorCode.SCHEMA_INVALID, params: { fields: ['x-arthome-surface'] } },
      });
    }
    expect(catalogSaw).toBeNull();
  });

  it('relays catalog’s refusal of a criterion, and hides its failures behind a 502', async () => {
    catalogAnswer = {
      status: 400,
      body: {
        error: {
          code: ApiErrorCode.SCHEMA_INVALID,
          nature: FailureNature.REFUSED,
          params: { fields: ['priceMaxMinor'] },
          traceId: TRACE_ID,
        },
        servedAt: '2026-09-26T20:00:00.000Z',
      },
    };
    const refused = await search({ priceMaxMinor: '2000' });
    catalogAnswer = { status: 500, body: { message: 'connection pool exhausted' } };
    const crashed = await search(
      { q: 'nuit' },
      { 'x-arthome-surface': Surface.STOREFRONT_WEB, traceparent: TRACEPARENT },
    );

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: { params: { fields: ['priceMaxMinor'] } } });
    expect(crashed.statusCode).toBe(502);
    expect(crashed.json()).toMatchObject({
      error: {
        code: ApiErrorCode.UPSTREAM_UNAVAILABLE,
        params: { service: 'catalog' },
        traceId: TRACE_ID,
      },
    });
    expect(JSON.stringify(crashed.json())).not.toContain('pool');
  });
});
