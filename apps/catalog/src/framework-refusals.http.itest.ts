import {
  applyMigrations,
  createDatabase,
  httpApp,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiErrorCode, FailureNature, FixedClock, Service } from '@arthome/core';
import { ErrorSchema } from '@arthome/core/schema';

import { CLOCK } from './clock.js';
import { EDGE_PROVIDERS } from './edge-providers.js';
import { CATALOG_SCHEMA } from './itest/schema.js';
import { VenuesModule } from './venues/venues.module.js';

/** What Fastify refuses before a handler runs still leaves in the error envelope (transport.md §5.5). */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const NOW = '2026-10-04T10:00:00.000Z';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const ONE_MIB = 1024 * 1024;

let stack: StartedStack;
let app: NestFastifyApplication;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'catalog_framework_refusals_itest');
  app = await httpApp({
    imports: [VenuesModule],
    providers: EDGE_PROVIDERS,
    caller: { service: Service.CATALOG, clock: new FixedClock(NOW) },
    dataSource: await applyMigrations(database, CATALOG_SCHEMA),
    overrides: [[CLOCK, new FixedClock(NOW)]],
  });
}, STARTUP_MS);

afterAll(async () => {
  await app?.close();
  await stack?.stop();
});

function postVenue(contentType: string, payload: string) {
  return app.inject({
    method: 'POST',
    url: '/venues',
    headers: { 'content-type': contentType, traceparent: TRACEPARENT },
    payload,
  });
}

type Injected = Awaited<ReturnType<NestFastifyApplication['inject']>>;

function expectEnvelope(response: Injected, status: number): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/json/);
  const body = response.json<{ error: unknown; servedAt: unknown }>();
  expect(Object.keys(body).sort()).toEqual(['error', 'servedAt']);
  ErrorSchema.parse(body.error);
}

describe('the refusals Fastify answers before catalog’s handlers', () => {
  it(
    'answers a malformed JSON body with 400 api.schema_invalid, never the parser’s message',
    async () => {
      const response = await postVenue('application/json', '{"name": ');

      expectEnvelope(response, 400);
      expect(response.json()).toMatchObject({
        error: { code: ApiErrorCode.SCHEMA_INVALID, nature: FailureNature.REFUSED },
      });
      expect(response.body).not.toContain('JSON');
    },
    CASE_MS,
  );

  it.each(['application/xml', 'text/plain', 'application/x-www-form-urlencoded'])(
    'answers a %s body with 415, since the contract speaks JSON alone',
    async (contentType) => {
      const response = await postVenue(contentType, 'name=Port&city=Marseille&country=FR');

      expectEnvelope(response, 415);
      expect(response.json()).toMatchObject({
        error: { code: ApiErrorCode.UNSUPPORTED_MEDIA_TYPE, nature: FailureNature.REFUSED },
      });
      expect(response.body).not.toContain('Unsupported');
    },
    CASE_MS,
  );

  it(
    'answers a body over 1 MiB with 413',
    async () => {
      const response = await postVenue(
        'application/json',
        JSON.stringify({ name: 'a'.repeat(ONE_MIB) }),
      );

      expectEnvelope(response, 413);
      expect(response.json()).toMatchObject({
        error: { code: ApiErrorCode.PAYLOAD_TOO_LARGE, nature: FailureNature.REFUSED },
      });
      expect(response.body).not.toContain('too large');
    },
    CASE_MS,
  );

  it(
    'answers an unknown route with 404 api.not_found, never the path it was asked',
    async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/nowhere',
        headers: { traceparent: TRACEPARENT },
      });

      expectEnvelope(response, 404);
      expect(response.json()).toMatchObject({
        error: { code: ApiErrorCode.NOT_FOUND, nature: FailureNature.REFUSED },
      });
      expect(response.body).not.toContain('nowhere');
    },
    CASE_MS,
  );
});
