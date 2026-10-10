import { httpApp } from '@arthome-platform/testing';
import { Controller, Module } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  callerService,
  defineErrorModel,
  routeBuilder,
  service,
  type HandlerOutput,
} from '@arthome/contracts/http';
import { ApiErrorCode, FixedClock, InternalTokenIssuer, Service } from '@arthome/core';

import { DEADLINE_HEADER } from './deadline.js';
import { edgeProviders } from './edge-providers.js';
import { Endpoint, serveEndpoints } from './endpoint.js';

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
        schema: z.looseObject({ servedAt: z.string(), data: z.object({ served: z.boolean() }) }),
      },
    },
  },
};

const readForStorefront = builder
  .identity(service)
  .requires(callerService(InternalTokenIssuer.STOREFRONT_BFF))
  .defineRoute({
    method: 'get',
    path: '/for-storefront',
    operationId: 'readForStorefront',
    responses: answered,
  });

const readForStudio = builder
  .identity(service)
  .requires(callerService(InternalTokenIssuer.STUDIO_BFF))
  .defineRoute({
    method: 'get',
    path: '/for-studio',
    operationId: 'readForStudio',
    responses: answered,
  });

const readForNobody = builder
  .identity(service)
  .requires({ ...callerService(InternalTokenIssuer.STUDIO_BFF), params: { issuers: [] } })
  .defineRoute({
    method: 'get',
    path: '/for-nobody',
    operationId: 'readForNobody',
    responses: answered,
  });

const readForAStranger = builder
  .identity(service)
  .requires({ ...callerService(InternalTokenIssuer.STUDIO_BFF), params: { issuers: ['bff-tv'] } })
  .defineRoute({
    method: 'get',
    path: '/for-a-stranger',
    operationId: 'readForAStranger',
    responses: answered,
  });

@Controller()
class CallersController {
  @Endpoint(readForStorefront)
  public async readForStorefront(): Promise<HandlerOutput<typeof readForStorefront>> {
    return Promise.resolve({ data: { served: true } });
  }

  @Endpoint(readForStudio)
  public async readForStudio(): Promise<HandlerOutput<typeof readForStudio>> {
    return Promise.resolve({ data: { served: true } });
  }
}

@Controller()
class NoIssuerController {
  @Endpoint(readForNobody)
  public async readForNobody(): Promise<HandlerOutput<typeof readForNobody>> {
    return Promise.resolve({ data: { served: true } });
  }
}

@Controller()
class StrangerController {
  @Endpoint(readForAStranger)
  public async readForAStranger(): Promise<HandlerOutput<typeof readForAStranger>> {
    return Promise.resolve({ data: { served: true } });
  }
}

const CLOCK = Symbol('Clock');
const clock = new FixedClock(Date.now());
const edge = edgeProviders({ service: Service.STREAMING, clock: CLOCK });

@Module({ controllers: [CallersController], providers: edge })
class CallersModule {}

@Module({ controllers: [NoIssuerController], providers: edge })
class NoIssuerModule {}

@Module({ controllers: [StrangerController], providers: edge })
class StrangerModule {}

let app: Awaited<ReturnType<typeof httpApp>>;

beforeAll(async () => {
  app = await httpApp({
    imports: [CallersModule],
    providers: [],
    configure: serveEndpoints,
    caller: {
      service: Service.STREAMING,
      clock,
      accountId: '01a0e700-0000-7000-8000-0000000000c1',
    },
  });
});

afterAll(async () => {
  await app.close();
});

const deadline = (): Record<string, string> => ({
  [DEADLINE_HEADER]: new Date(clock.nowMs() + 60_000).toISOString(),
});

describe('the callerService rule', () => {
  it('serves a BFF the route names', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/for-storefront',
      headers: deadline(),
    });

    expect(response.statusCode).toBe(200);
  });

  it('refuses 403 api.forbidden a BFF the route does not name', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/for-studio',
      headers: deadline(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: ApiErrorCode.FORBIDDEN } });
  });

  it('fails the boot on a rule naming no issuer, or one no BFF mints as', async () => {
    await expect(
      httpApp({ imports: [NoIssuerModule], providers: [], configure: serveEndpoints }),
    ).rejects.toThrow(/readForNobody \(rule callerService: it names no issuer\)/);
    await expect(
      httpApp({ imports: [StrangerModule], providers: [], configure: serveEndpoints }),
    ).rejects.toThrow(/readForAStranger \(rule callerService: no BFF mints as "bff-tv"\)/);
  });
});
