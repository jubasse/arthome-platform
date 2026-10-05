import { httpApp } from '@arthome-platform/testing';
import { Controller, Module } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  defineErrorModel,
  routeBuilder,
  service,
  type HandlerInput,
  type HandlerOutput,
} from '@arthome/contracts/http';
import { ApiErrorCode, FixedClock, InternalTokenIssuer, Service } from '@arthome/core';

import { DEADLINE_HEADER } from './deadline.js';
import { edgeProviders } from './edge-providers.js';
import { EndpointInput } from './endpoint-input.js';
import { Endpoint, serveEndpoints } from './endpoint.js';

/** Core's `service` identity, bound by every service, on fixture routes. A public route needs the service's allow-list. */

const ACCOUNT = '01a0e700-0000-7000-8000-0000000000c1';

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
  ): Promise<HandlerOutput<typeof readOverlay>> {
    return Promise.resolve({ data: { caller: JSON.stringify(principal) } });
  }
}

const peekOverlay = builder.identity(service).optionalAuth().defineRoute({
  method: 'get',
  path: '/overlay/peek',
  operationId: 'peekOverlay',
  responses: answered,
});

@Controller()
class PeekController {
  @Endpoint(peekOverlay)
  public async peekOverlay(
    @EndpointInput(peekOverlay) { principal }: HandlerInput<typeof peekOverlay>,
  ): Promise<HandlerOutput<typeof peekOverlay>> {
    return Promise.resolve({ data: { caller: JSON.stringify(principal) } });
  }
}

@Controller()
class WebhookController {
  @Endpoint(takeWebhook)
  public async takeWebhook(): Promise<HandlerOutput<typeof takeWebhook>> {
    return Promise.resolve({ data: { caller: 'nobody' } });
  }
}

const CLOCK = Symbol('Clock');

@Module({
  controllers: [OverlayController],
  providers: edgeProviders({ service: Service.CATALOG, clock: CLOCK }),
})
class OverlayModule {}

@Module({
  controllers: [WebhookController],
  providers: edgeProviders({ service: Service.CATALOG, clock: CLOCK }),
})
class StrayPublicModule {}

@Module({
  controllers: [WebhookController],
  providers: edgeProviders({
    service: Service.CATALOG,
    clock: CLOCK,
    publicRoutes: ['takeWebhook'],
  }),
})
class AllowedPublicModule {}

@Module({
  controllers: [PeekController],
  providers: edgeProviders({ service: Service.CATALOG, clock: CLOCK }),
})
class StrayOptionalModule {}

@Module({
  controllers: [PeekController],
  providers: edgeProviders({
    service: Service.CATALOG,
    clock: CLOCK,
    publicRoutes: ['peekOverlay'],
  }),
})
class AllowedOptionalModule {}

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
    const response = await app.inject({
      method: 'GET',
      url: '/v1/overlay',
      headers: { [DEADLINE_HEADER]: new Date(clock.nowMs() + 60_000).toISOString() },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.json<{ data: { caller: string } }>().data.caller)).toEqual({
      callingService: InternalTokenIssuer.STOREFRONT_BFF,
      userId: ACCOUNT,
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
});

describe('a route a call without a token reaches, on a service', () => {
  it('fails the boot, since the internal token is a service’s only authorisation', async () => {
    await expect(
      httpApp({ imports: [StrayPublicModule], providers: [], configure: serveEndpoints }),
    ).rejects.toThrow(/takeWebhook \(public on a service\)/);
  });

  it('fails the boot when optional too, since an optional route lets that call in', async () => {
    await expect(
      httpApp({ imports: [StrayOptionalModule], providers: [], configure: serveEndpoints }),
    ).rejects.toThrow(/peekOverlay \(optional on a service\)/);
    const allowed = await httpApp({
      imports: [AllowedOptionalModule],
      providers: [],
      configure: serveEndpoints,
    });
    const response = await allowed.inject({
      method: 'GET',
      url: '/v1/overlay/peek',
      headers: { [DEADLINE_HEADER]: new Date(clock.nowMs() + 60_000).toISOString() },
    });
    await allowed.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { caller: 'null' } });
  });

  it('answers without a token when the service names it in its allow-list', async () => {
    const allowed = await httpApp({
      imports: [AllowedPublicModule],
      providers: [],
      configure: serveEndpoints,
    });
    const response = await allowed.inject({ method: 'POST', url: '/v1/webhook' });
    await allowed.close();

    expect(response.statusCode).toBe(200);
  });
});
