import { httpApp } from '@arthome-platform/testing';
import { Controller, Module } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  defineErrorModel,
  identity,
  routeBuilder,
  type HandlerInput,
} from '@arthome/contracts/http';
import { ApiErrorCode, FixedClock, Service } from '@arthome/core';

import { edgeProviders } from './edge-providers.js';
import { EndpointInput } from './endpoint-input.js';
import { Endpoint, serveEndpoints } from './endpoint.js';

/**
 * The `service` identity bound by every service, on fixture routes: core declares it with the
 *   internal contracts (D-121), under this name.
 */

const ACCOUNT = '01a0e700-0000-7000-8000-0000000000c1';

const service = identity('service', {
  schemes: { read: [{ internalToken: [] }], write: [{ internalToken: [] }] },
  principal: z.object({ accountId: z.string().nullable(), deviceId: z.string().nullable() }),
  internal: true,
});

const builder = routeBuilder(
  defineErrorModel<string>({
    standard: {},
    envelopeOf: (code) => z.object({ error: z.object({ code: z.literal(code) }) }),
  }),
).version(1);

const answered = {
  200: {
    description: 'Answered.',
    content: {
      'application/json': {
        schema: z.looseObject({ servedAt: z.string(), data: z.object({ caller: z.string() }) }),
      },
    },
  },
};

const readOverlay = builder.identity(service).defineRoute({
  method: 'get',
  path: '/overlay',
  operationId: 'readOverlay',
  responses: answered,
});

const takeWebhook = builder.public().defineRoute({
  method: 'post',
  path: '/webhook',
  operationId: 'takeWebhook',
  responses: answered,
});

@Controller()
class OverlayController {
  @Endpoint(readOverlay)
  public async readOverlay(
    @EndpointInput(readOverlay) { principal }: HandlerInput<typeof readOverlay>,
  ): Promise<{ caller: string }> {
    return Promise.resolve({ caller: JSON.stringify(principal) });
  }

  @Endpoint(takeWebhook)
  public async takeWebhook(): Promise<{ caller: string }> {
    return Promise.resolve({ caller: 'nobody' });
  }
}

const CLOCK = Symbol('Clock');

@Module({
  controllers: [OverlayController],
  providers: edgeProviders({ service: Service.CATALOG, clock: CLOCK }),
})
class OverlayModule {}

const clock = new FixedClock(Date.now());
let app: Awaited<ReturnType<typeof httpApp>>;
let anonymous: Awaited<ReturnType<typeof httpApp>>;

beforeAll(async () => {
  app = await httpApp({
    imports: [OverlayModule],
    providers: [],
    configure: serveEndpoints,
    caller: { service: Service.CATALOG, clock, accountId: ACCOUNT },
  });
  anonymous = await httpApp({ imports: [OverlayModule], providers: [], configure: serveEndpoints });
});

afterAll(async () => {
  await app.close();
  await anonymous.close();
});

describe('the service identity', () => {
  it('verifies the internal token and hands over the caller it names', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/overlay' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.json<{ data: { caller: string } }>().data.caller)).toEqual({
      accountId: ACCOUNT,
      deviceId: null,
    });
  });

  it('refuses a call without a token, and one whose token is not a bearer token', async () => {
    const without = await anonymous.inject({ method: 'GET', url: '/v1/overlay' });
    const malformed = await anonymous.inject({
      method: 'GET',
      url: '/v1/overlay',
      headers: { authorization: 'Basic abc' },
    });

    expect(without.statusCode).toBe(401);
    expect(without.json()).toMatchObject({ error: { code: ApiErrorCode.UNAUTHENTICATED } });
    expect(malformed.statusCode).toBe(401);
  });

  it('lets a route the contract declares public through without a token', async () => {
    const response = await anonymous.inject({ method: 'POST', url: '/v1/webhook' });

    expect(response.statusCode).toBe(200);
  });
});
