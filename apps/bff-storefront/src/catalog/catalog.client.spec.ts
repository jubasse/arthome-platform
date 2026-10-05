import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { readInternalTokenSigningKey } from '@arthome-platform/config';
import { InternalTokenVerifier, RefusalException } from '@arthome-platform/http-edge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ApiErrorCode, FailureNature, SchemaIssueRule, Service, SystemClock } from '@arthome/core';

import { CatalogClient, type CatalogCall } from './catalog.client.js';
import { InternalTokenMinter } from '../internal-token.minter.js';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

/** A stand-in catalog: the path picks the answer, and the headers it received are kept. */
let received: IncomingHttpHeaders = {};
let server: Server;
let client: CatalogClient;
const minter = new InternalTokenMinter(
  readInternalTokenSigningKey({ NODE_ENV: 'test' }),
  new SystemClock(),
);

const SCHEMA_INVALID_PARAMS = {
  issues: [{ path: ['priceMaxMinor'], rule: SchemaIssueRule.INVALID_TYPE }],
};

function errorEnvelope(code: string, params: object = {}): string {
  return JSON.stringify({
    error: { code, nature: FailureNature.REFUSED, params, traceId: TRACEPARENT.slice(3, 35) },
    servedAt: '2026-09-26T20:00:00.000Z',
  });
}

const ANSWERS: Record<string, { status: number; body: string; delayMs?: number }> = {
  '/ok': { status: 200, body: JSON.stringify({ servedAt: '2026-09-26T20:00:00.000Z', n: 1 }) },
  '/off-contract': { status: 200, body: JSON.stringify({ servedAt: 'yesterday' }) },
  '/refused': {
    status: 400,
    body: errorEnvelope(ApiErrorCode.SCHEMA_INVALID, SCHEMA_INVALID_PARAMS),
  },
  '/forbidden': { status: 403, body: errorEnvelope(ApiErrorCode.FORBIDDEN) },
  '/late': { status: 504, body: errorEnvelope(ApiErrorCode.DEADLINE_EXCEEDED) },
  '/crashed': { status: 500, body: 'Internal Server Error' },
  '/slow': { status: 200, body: '{}', delayMs: 500 },
};

const Served = z.looseObject({ servedAt: z.iso.datetime() });

function call(budgetMs = 1_000): CatalogCall {
  return {
    deadline: new Date(Date.now() + budgetMs),
    traceparent: TRACEPARENT,
    callerLeft: new AbortController().signal,
  };
}

async function refusalOf(path: string, budgetMs?: number): Promise<RefusalException> {
  try {
    await client.get(path, new URLSearchParams(), call(budgetMs), Served);
  } catch (error) {
    if (error instanceof RefusalException) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

beforeAll(async () => {
  server = createServer((request, response) => {
    received = request.headers;
    const answer = ANSWERS[new URL(request.url ?? '/', 'http://catalog').pathname];
    setTimeout(() => {
      response.writeHead(answer?.status ?? 404, { 'content-type': 'application/json' });
      response.end(answer?.body ?? '{}');
    }, answer?.delayMs ?? 0);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  client = new CatalogClient(`http://localhost:${(server.address() as AddressInfo).port}`, minter);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('CatalogClient', () => {
  it('returns the body the schema accepts, having sent the trace and the deadline', async () => {
    const budget = call();
    const body = await client.get('/ok', new URLSearchParams({ q: 'nuit' }), budget, Served);

    expect(body).toMatchObject({ n: 1 });
    expect(received.traceparent).toBe(TRACEPARENT);
    expect(received['x-arthome-deadline']).toBe(budget.deadline.toISOString());
  });

  it('sends a token catalog verifies, naming no account', async () => {
    await client.get('/ok', new URLSearchParams(), call(), Served);
    const [scheme, token] = String(received.authorization).split(' ');
    expect(scheme).toBe('Bearer');
    const verifier = new InternalTokenVerifier(
      Service.CATALOG,
      { kind: 'local', keys: [publicHalfOf(readInternalTokenSigningKey({ NODE_ENV: 'test' }))] },
      new SystemClock(),
    );
    await expect(verifier.verify(token ?? '')).resolves.toMatchObject({ accountId: null });
  });

  it('relays an allowlisted refusal with its status and params', async () => {
    const refusal = await refusalOf('/refused');

    expect(refusal.getStatus()).toBe(400);
    expect(refusal.refusal).toEqual({
      code: ApiErrorCode.SCHEMA_INVALID,
      params: SCHEMA_INVALID_PARAMS,
      nature: FailureNature.REFUSED,
    });
  });

  it('turns every other failure into its own 502, never catalog’s code', async () => {
    for (const path of ['/forbidden', '/crashed', '/off-contract']) {
      const refusal = await refusalOf(path);
      expect(refusal.getStatus()).toBe(502);
      expect(refusal.refusal).toMatchObject({
        code: ApiErrorCode.UPSTREAM_UNAVAILABLE,
        params: { service: 'catalog' },
      });
    }
  });

  it('answers 504 when it stops waiting, or when catalog saw the deadline pass', async () => {
    for (const refusal of [await refusalOf('/slow', 100), await refusalOf('/late')]) {
      expect(refusal.getStatus()).toBe(504);
      expect(refusal.refusal.code).toBe(ApiErrorCode.UPSTREAM_TIMEOUT);
    }
  });

  it('answers 502 when catalog cannot be reached at all', async () => {
    // A port that was just listening and is now closed: the connection is refused.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));

    const refused = new CatalogClient(`http://localhost:${port}`, minter);
    await expect(refused.get('/ok', new URLSearchParams(), call(), Served)).rejects.toMatchObject({
      refusal: { code: ApiErrorCode.UPSTREAM_UNAVAILABLE },
    });
  });
});

function publicHalfOf({
  privateJwk,
}: ReturnType<typeof readInternalTokenSigningKey>): Record<string, string> {
  const { d: _private, ...publicHalf } = privateJwk;
  return publicHalf;
}
