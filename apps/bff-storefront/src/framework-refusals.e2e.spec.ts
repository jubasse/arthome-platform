import { enableUriVersioning } from '@arthome-platform/http-edge';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { StorefrontErrorEnvelopeSchema } from '@arthome/contracts/envelope';
import { ApiErrorCode, FailureNature, Surface } from '@arthome/core';

import { AppModule } from './app.module.js';

/** What Fastify refuses before a handler runs still leaves in the contract's error envelope. */

const SIGN_IN = '/v1/auth/sign-in';
const HEADERS = { 'x-arthome-surface': Surface.STOREFRONT_WEB };
const ONE_MIB = 1024 * 1024;

let app: NestFastifyApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  enableUriVersioning(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
});

function postSignIn(contentType: string, payload: string) {
  return app.inject({
    method: 'POST',
    url: SIGN_IN,
    headers: { ...HEADERS, 'content-type': contentType },
    payload,
  });
}

type Injected = Awaited<ReturnType<NestFastifyApplication['inject']>>;

function expectEnvelope(response: Injected, status: number): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/json/);
  const envelope = StorefrontErrorEnvelopeSchema.parse(response.json());
  expect(Object.keys(envelope).sort()).toEqual(['error', 'servedAt']);
}

describe('the refusals Fastify answers before the storefront BFF’s handlers', () => {
  it('answers a malformed JSON body with 400 api.schema_invalid, never the parser’s message', async () => {
    const response = await postSignIn('application/json', '{"email": ');

    expectEnvelope(response, 400);
    expect(response.json()).toMatchObject({
      error: { code: ApiErrorCode.SCHEMA_INVALID, nature: FailureNature.REFUSED },
    });
    expect(response.body).not.toContain('JSON');
  });

  it.each(['application/xml', 'text/plain', 'application/x-www-form-urlencoded'])(
    'answers a %s body with 415, since the contract speaks JSON alone',
    async (contentType) => {
      const response = await postSignIn(contentType, 'email=a%40b.test&password=x&mode=bearer');

      expectEnvelope(response, 415);
      expect(response.body).not.toContain('Unsupported');
    },
  );

  it('answers a body over 1 MiB with 413', async () => {
    const response = await postSignIn(
      'application/json',
      JSON.stringify({ email: 'a'.repeat(ONE_MIB) }),
    );

    expectEnvelope(response, 413);
    expect(response.body).not.toContain('too large');
  });

  it('answers an unknown route with 404 api.not_found, never the path it was asked', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/nowhere', headers: HEADERS });

    expectEnvelope(response, 404);
    expect(response.json()).toMatchObject({
      error: { code: ApiErrorCode.NOT_FOUND, nature: FailureNature.REFUSED },
    });
    expect(response.body).not.toContain('nowhere');
  });
});
