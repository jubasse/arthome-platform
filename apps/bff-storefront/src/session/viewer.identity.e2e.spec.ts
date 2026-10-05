import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Endpoint, EndpointInput, serveEndpoints } from '@arthome-platform/http-edge';
import { Controller, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  defineErrorModel,
  identity,
  routeBuilder,
  type HandlerInput,
  type HandlerOutput,
} from '@arthome/contracts/http';
import { ApiErrorCode, FixedClock, Surface } from '@arthome/core';

import { PairedDeviceVerifier } from './paired-device.verifier.js';
import { SESSION_COOKIE } from './session-carriers.js';
import { AppModule } from '../app.module.js';
import { CLOCK } from '../clock.js';
import { IDENTITY_URL } from '../identity/identity.client.js';

/**
 * The `viewer` identity bound by name, on fixture routes declared through the new builder: no
 *   storefront route has opted in yet. Its schemes are the storefront's.
 */

const ACCOUNT = '01a0e700-0000-7000-8000-0000000000c1';
const DEVICE = '01a0e700-0000-7000-8000-0000000000d1';
const GOOD_TOKEN = 'sess_good';

const viewer = identity('viewer', {
  schemes: {
    read: [{ sessionCookie: [] }, { bearerToken: [] }],
    write: [{ sessionCookie: [], csrfToken: [] }, { bearerToken: [] }],
  },
  principal: z.object({ accountId: z.string(), deviceId: z.string() }),
});

const viewers = routeBuilder(
  defineErrorModel<string>({
    standard: {},
    envelopeOf: (code) => z.object({ error: z.object({ code: z.literal(code) }) }),
  }),
)
  .version(1)
  .identity(viewer);

const answered = (data: z.ZodType) => ({
  200: {
    description: 'Answered.',
    content: { 'application/json': { schema: z.looseObject({ servedAt: z.string(), data }) } },
  },
});

const whoAmI = viewers.defineRoute({
  method: 'get',
  path: '/fixture/me',
  operationId: 'fixtureWhoAmI',
  responses: answered(z.object({ principal: z.string() })),
});

const noteDown = viewers.defineRoute({
  method: 'post',
  path: '/fixture/notes',
  operationId: 'fixtureNoteDown',
  requestBody: { content: { 'application/json': { schema: z.object({ note: z.string() }) } } },
  responses: answered(z.object({ note: z.string() })),
});

const browse = viewers.optionalAuth().defineRoute({
  method: 'get',
  path: '/fixture/browse',
  operationId: 'fixtureBrowse',
  responses: answered(z.object({ principal: z.string() })),
});

const leaving = viewers
  .identity(viewer, { csrfExempt: 'A forged departure grants nothing.' })
  .optionalAuth({ refusedCredentialIsAnonymous: 'A dead session is already left.' })
  .defineRoute({
    method: 'post',
    path: '/fixture/leave',
    operationId: 'fixtureLeave',
    responses: answered(z.object({ principal: z.string() })),
  });

const viewerOrDevice = identity('viewer_or_device', {
  schemes: {
    read: [{ sessionCookie: [] }, { bearerToken: [] }, { deviceToken: [] }],
    write: [{ sessionCookie: [], csrfToken: [] }, { bearerToken: [] }, { deviceToken: [] }],
  },
  principal: z.union([
    z.object({ accountId: z.string(), deviceId: z.string() }),
    z.object({ deviceId: z.string() }),
  ]),
});

const bootstrapRead = routeBuilder(
  defineErrorModel<string>({
    standard: {},
    envelopeOf: (code) => z.object({ error: z.object({ code: z.literal(code) }) }),
  }),
)
  .version(1)
  .identity(viewerOrDevice)
  .defineRoute({
    method: 'get',
    path: '/fixture/bootstrap',
    operationId: 'fixtureBootstrap',
    responses: answered(z.object({ principal: z.string() })),
  });

@Controller()
class FixtureController {
  @Endpoint(whoAmI)
  public async whoAmI(
    @EndpointInput(whoAmI) { principal }: HandlerInput<typeof whoAmI>,
  ): Promise<HandlerOutput<typeof whoAmI>> {
    return Promise.resolve({ data: { principal: JSON.stringify(principal) } });
  }

  @Endpoint(noteDown)
  public async noteDown(
    @EndpointInput(noteDown) { body }: HandlerInput<typeof noteDown>,
  ): Promise<HandlerOutput<typeof noteDown>> {
    return Promise.resolve({ data: { note: body.note } });
  }

  @Endpoint(browse)
  public async browse(
    @EndpointInput(browse) { principal }: HandlerInput<typeof browse>,
  ): Promise<HandlerOutput<typeof browse>> {
    return Promise.resolve({ data: { principal: JSON.stringify(principal) } });
  }

  @Endpoint(leaving)
  public async leave(
    @EndpointInput(leaving) { principal }: HandlerInput<typeof leaving>,
  ): Promise<HandlerOutput<typeof leaving>> {
    return Promise.resolve({ data: { principal: JSON.stringify(principal) } });
  }

  @Endpoint(bootstrapRead)
  public async bootstrapRead(
    @EndpointInput(bootstrapRead) { principal }: HandlerInput<typeof bootstrapRead>,
  ): Promise<HandlerOutput<typeof bootstrapRead>> {
    return Promise.resolve({ data: { principal: JSON.stringify(principal) } });
  }
}

@Module({ controllers: [FixtureController] })
class FixtureModule {}

let resolutions = 0;
let identityStandIn: Server;
let app: NestFastifyApplication;

beforeAll(async () => {
  identityStandIn = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      resolutions += 1;
      const { token } = JSON.parse(body) as { token: string };
      const session =
        token === GOOD_TOKEN
          ? {
              accountId: ACCOUNT,
              deviceId: DEVICE,
              expiresAt: '2026-11-05T10:00:00.000Z',
              account: { publicHandle: '@marie', emailVerified: true },
            }
          : null;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ servedAt: '2026-10-05T10:00:00.000Z', data: { session } }));
    });
  });
  await new Promise<void>((resolve) => identityStandIn.listen(0, resolve));

  const moduleRef = await Test.createTestingModule({ imports: [AppModule, FixtureModule] })
    .overrideProvider(IDENTITY_URL)
    .useValue(`http://localhost:${String((identityStandIn.address() as AddressInfo).port)}`)
    // An hour ahead, so no deadline falls due under load: search.e2e records why.
    .overrideProvider(CLOCK)
    .useValue(new FixedClock(Date.now() + 3_600_000))
    .overrideProvider(PairedDeviceVerifier)
    .useValue({
      verify: (token: string) =>
        Promise.resolve(token === PAIRED_TOKEN ? { deviceId: DEVICE } : null),
    })
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  serveEndpoints(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  identityStandIn.closeAllConnections();
  await new Promise((resolve) => identityStandIn.close(resolve));
});

beforeEach(() => {
  resolutions = 0;
});

const PAIRED_TOKEN = 'paired-device-token';

const WEB = { 'x-arthome-surface': Surface.STOREFRONT_WEB };

describe('the viewer identity, applied by Endpoint', () => {
  it('refuses a route that requires a viewer when no session is presented', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/fixture/me', headers: WEB });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: ApiErrorCode.UNAUTHENTICATED } });
    expect(resolutions).toBe(0);
  });

  it('resolves the session through identity and hands over the declared principal alone', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/fixture/me',
      headers: { ...WEB, authorization: `Bearer ${GOOD_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.json<{ data: { principal: string } }>().data.principal)).toEqual({
      accountId: ACCOUNT,
      deviceId: DEVICE,
    });
  });

  it('refuses a session identity does not know', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/fixture/me',
      headers: { ...WEB, authorization: 'Bearer sess_unknown' },
    });

    expect(response.statusCode).toBe(401);
    expect(resolutions).toBe(1);
  });

  it('asks a cookie write for its CSRF token before resolving anything', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/fixture/notes',
      headers: WEB,
      cookies: { [SESSION_COOKIE]: GOOD_TOKEN },
      payload: { note: 'hello' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: ApiErrorCode.FORBIDDEN } });
    expect(resolutions).toBe(0);
  });

  it('asks a bearer write for no CSRF token, which only a cookie needs', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/fixture/notes',
      headers: { ...WEB, authorization: `Bearer ${GOOD_TOKEN}` },
      payload: { note: 'hello' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { note: 'hello' } });
  });

  it('asks a route that declares csrfExempt for no CSRF token on a cookie write', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/fixture/leave',
      headers: WEB,
      cookies: { [SESSION_COOKIE]: GOOD_TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.json<{ data: { principal: string } }>().data.principal)).toEqual({
      accountId: ACCOUNT,
      deviceId: DEVICE,
    });
  });

  it('counts a refused credential as none where the route declares it so', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/fixture/leave',
      headers: { ...WEB, authorization: 'Bearer sess_revoked' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { principal: 'null' } });
  });

  it('counts a malformed carrier as none where the route declares it so', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/fixture/leave',
      headers: { ...WEB, authorization: 'Basic a.b' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { principal: 'null' } });
  });

  it('counts both carriers at once as none where the route declares it so', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/fixture/leave',
      headers: { ...WEB, authorization: `Bearer ${GOOD_TOKEN}` },
      cookies: { [SESSION_COOKIE]: GOOD_TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { principal: 'null' } });
  });

  it('still refuses a malformed carrier where the route does not declare it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/fixture/me',
      headers: { ...WEB, authorization: 'Basic a.b' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('lets an anonymous caller into an optional route, with a null principal', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/fixture/browse', headers: WEB });

    expect(response.json()).toMatchObject({ data: { principal: 'null' } });
    expect(resolutions).toBe(0);
  });
});

describe('the viewer_or_device identity', () => {
  it('takes the viewer’s session first', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/fixture/bootstrap',
      headers: { ...WEB, authorization: `Bearer ${GOOD_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.json<{ data: { principal: string } }>().data.principal)).toEqual({
      accountId: ACCOUNT,
      deviceId: DEVICE,
    });
  });

  it('hands a paired device’s token over as the device principal', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/fixture/bootstrap',
      headers: { ...WEB, 'x-arthome-device-token': PAIRED_TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.json<{ data: { principal: string } }>().data.principal)).toEqual({
      deviceId: DEVICE,
    });
    expect(resolutions).toBe(0);
  });

  it('refuses a device token that names no paired device', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/fixture/bootstrap',
      headers: { ...WEB, 'x-arthome-device-token': 'device-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: ApiErrorCode.UNAUTHENTICATED } });
    expect(resolutions).toBe(0);
  });

  it('refuses a caller presenting neither', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/fixture/bootstrap',
      headers: WEB,
    });

    expect(response.statusCode).toBe(401);
  });
});
