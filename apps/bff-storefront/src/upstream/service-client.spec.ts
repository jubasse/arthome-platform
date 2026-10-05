import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { readInternalTokenSigningKey } from '@arthome-platform/config';
import { DEADLINE_HEADER, RefusalException } from '@arthome-platform/http-edge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineErrorModel, defineRoute, routeBuilder, type Route } from '@arthome/contracts/http';
import { ApiErrorCode, FailureNature, OrderErrorCode, Service, SystemClock } from '@arthome/core';

import { ServiceClient, type ServiceCall } from './service-client.js';
import { InternalTokenMinter } from '../internal-token.minter.js';

const PRICE_STALE_PARAMS = {
  expectedAmountMinor: 4500,
  currentAmountMinor: 5200,
  currencyCode: 'EUR',
};

function errorEnvelope(code: string, params: object = {}): string {
  return JSON.stringify({
    error: {
      code,
      nature: FailureNature.REFUSED,
      params,
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    },
    servedAt: '2026-10-05T10:00:00.000Z',
  });
}

/** A stand-in service: the path picks the answer, and the headers it received are kept. */
const ANSWERS: Record<string, { status: number; body: string }> = {
  '/ok': { status: 200, body: JSON.stringify({ data: {} }) },
  '/price-stale': {
    status: 409,
    body: errorEnvelope(OrderErrorCode.PRICE_STALE, PRICE_STALE_PARAMS),
  },
  '/sold-out': { status: 409, body: errorEnvelope(OrderErrorCode.SOLD_OUT) },
  '/forbidden': { status: 403, body: errorEnvelope(ApiErrorCode.FORBIDDEN) },
  '/unauthenticated': { status: 401, body: errorEnvelope(ApiErrorCode.UNAUTHENTICATED) },
  '/not-found': { status: 404, body: errorEnvelope(ApiErrorCode.NOT_FOUND) },
};

const model = defineErrorModel<string>({
  standard: {},
  envelopeOf: (code) => z.object({ error: z.object({ code: z.literal(code) }) }),
});

/** A BFF route declaring its errors: the stale price and, for its own use, the 401 and the 403. */
const placeOrder: Route = routeBuilder(model)
  .version(1)
  .defineRoute({
    method: 'post',
    path: '/orders',
    operationId: 'placeOrder',
    errors: [
      OrderErrorCode.PRICE_STALE,
      ApiErrorCode.UNAUTHENTICATED,
      ApiErrorCode.FORBIDDEN,
      ApiErrorCode.NOT_FOUND,
    ],
    responses: { 201: { description: 'Placed.' } },
  });

/** A BFF route declaring no error by code: the allowlist still decides. */
const legacyRead: Route = defineRoute({
  method: 'get',
  version: 1,
  path: '/orders/{orderId}',
  operationId: 'legacyRead',
  parameters: [{ name: 'orderId', in: 'path', required: true, schema: z.string() }],
  responses: { 200: { description: 'The order.' } },
});

let received: IncomingHttpHeaders = {};
let server: Server;
let client: ServiceClient;

beforeAll(async () => {
  server = createServer((request, response) => {
    received = request.headers;
    const answer = ANSWERS[new URL(request.url ?? '/', 'http://service').pathname];
    response.writeHead(answer?.status ?? 404, { 'content-type': 'application/json' });
    response.end(answer?.body ?? '{}');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  client = new ServiceClient(
    Service.TICKETING,
    `http://localhost:${(server.address() as AddressInfo).port}`,
    new InternalTokenMinter(readInternalTokenSigningKey({ NODE_ENV: 'test' }), new SystemClock()),
  );
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function callFor(route?: Route): ServiceCall {
  return {
    deadline: new Date(Date.now() + 1_000),
    traceparent: '',
    callerLeft: new AbortController().signal,
    caller: null,
    ...(route !== undefined && { route }),
  };
}

async function refusalFrom(path: string, route?: Route): Promise<RefusalException> {
  try {
    await client.request({ method: 'POST', path }, callFor(route), z.looseObject({}));
  } catch (error) {
    if (error instanceof RefusalException) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('a call to a service', () => {
  it('relays its headers, and none of them replaces the token or the deadline', async () => {
    const deadline = new Date(Date.now() + 1_000);
    await client.request(
      {
        method: 'POST',
        path: '/ok',
        headers: {
          authorization: 'Bearer forged',
          [DEADLINE_HEADER]: '2099-01-01T00:00:00.000Z',
          'idempotency-key': 'a-key',
        },
      },
      { ...callFor(), deadline },
      z.looseObject({ data: z.looseObject({}) }),
    );

    expect(received['idempotency-key']).toBe('a-key');
    expect(received.authorization).not.toBe('Bearer forged');
    expect(received.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(received[DEADLINE_HEADER]).toBe(deadline.toISOString());
  });
});

describe('a service refusal, for a route that declares its errors', () => {
  it('is relayed with its params when the route declares its code', async () => {
    const refusal = await refusalFrom('/price-stale', placeOrder);

    expect(refusal.getStatus()).toBe(409);
    expect(refusal.refusal).toStrictEqual({
      code: OrderErrorCode.PRICE_STALE,
      params: PRICE_STALE_PARAMS,
      nature: FailureNature.REFUSED,
    });
  });

  it('becomes the BFF’s 502 when the route does not declare its code', async () => {
    const refusal = await refusalFrom('/sold-out', placeOrder);

    expect(refusal.getStatus()).toBe(502);
    expect(refusal.refusal).toMatchObject({
      code: ApiErrorCode.UPSTREAM_UNAVAILABLE,
      params: { service: Service.TICKETING },
    });
  });

  it('becomes the BFF’s 502 when it is about the call itself, though the route declares the code', async () => {
    for (const path of ['/unauthenticated', '/forbidden']) {
      const refusal = await refusalFrom(path, placeOrder);

      expect(refusal.getStatus()).toBe(502);
      expect(refusal.refusal.code).toBe(ApiErrorCode.UPSTREAM_UNAVAILABLE);
    }
  });
});

describe('a service refusal, for a route that declares no error by code', () => {
  it('is relayed when the allowlist names it, and becomes a 502 otherwise', async () => {
    for (const route of [legacyRead, undefined]) {
      expect((await refusalFrom('/not-found', route)).getStatus()).toBe(404);
      expect((await refusalFrom('/price-stale', route)).getStatus()).toBe(502);
    }
  });
});
