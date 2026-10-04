import { httpApp } from '@arthome-platform/testing';
import {
  Controller,
  HttpStatus,
  Logger,
  Module,
  StandardSchemaValidationPipe,
  type ExecutionContext,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, HttpAdapterHost } from '@nestjs/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  BATCH_BODY_LIMIT,
  DEFAULT_BODY_LIMIT,
  Freshness,
  cache,
  defineErrorModel,
  defineRoute,
  identity,
  requirement,
  restricted,
  routeBuilder,
  sensitive,
  type HandlerInput,
  type Requirement,
} from '@arthome/contracts/http';
import { ApiErrorCode, FailureNature, FixedClock } from '@arthome/core';

import type { EndpointGuards, IdentityGuard, RuleGuard } from './endpoint-access.js';
import { EndpointInput, EndpointPrincipal } from './endpoint-input.js';
import { endpointProviders } from './endpoint-providers.js';
import { Endpoint, serveEndpoints } from './endpoint.js';
import { ErrorEnvelopeFilter } from './error-envelope.filter.js';
import { unauthenticated } from './principal.js';
import { RefusalException, schemaInvalidException } from './refusal.js';
import { SuccessEnvelopeInterceptor } from './success-envelope.interceptor.js';

const NOW = '2026-10-05T10:00:00.000Z';
const MEMBER_HEADER = 'x-test-member';

const model = defineErrorModel<string>({
  standard: {},
  envelopeOf: (code) => z.object({ error: z.object({ code: z.literal(code) }) }),
});

const member = identity('member', {
  schemes: { read: [{ session: [] }], write: [{ session: [] }] },
  principal: z.object({ accountId: z.string(), rights: z.array(z.string()) }),
});

const gold = requirement('tier', {
  params: { level: 'gold' },
  errors: { 403: [ApiErrorCode.FORBIDDEN] },
});

const envelope = <S extends z.ZodType>(data: S) => z.looseObject({ servedAt: z.string(), data });

const thingId = { name: 'thingId', in: 'path', required: true, schema: z.uuid() } as const;
const base = routeBuilder(model).version(1);
const members = base.identity(member);

const readThing = members.cache(cache(Freshness.MINUTE, { vary: ['X-Test-Member'] })).defineRoute({
  method: 'get',
  path: '/things/{thingId}',
  operationId: 'readThing',
  parameters: [thingId, { name: 'verbose', in: 'query', schema: z.boolean() }],
  responses: {
    200: {
      description: 'The thing.',
      content: {
        'application/json': {
          schema: envelope(
            z.object({
              thingId: z.string(),
              readBy: z.string(),
              verbose: z.boolean(),
              revenue: restricted(z.number(), 'canRevenue'),
            }),
          ),
        },
      },
    },
  },
});

const browseThings = members.optionalAuth().defineRoute({
  method: 'get',
  path: '/things',
  operationId: 'browseThings',
  responses: {
    200: {
      description: 'The things.',
      content: {
        'application/json': {
          schema: envelope(
            z.object({
              anonymous: z.boolean(),
              note: restricted(z.string(), 'signedIn'),
            }),
          ),
        },
      },
    },
  },
});

const promoteThing = members.requires(gold).defineRoute({
  method: 'post',
  path: '/things/{thingId}/promote',
  operationId: 'promoteThing',
  parameters: [thingId],
  requestBody: {
    required: true,
    content: { 'application/json': { schema: z.object({ reason: z.string().min(1) }) } },
  },
  responses: {
    200: {
      description: 'Promoted.',
      content: {
        'application/json': { schema: envelope(z.object({ reason: z.string() })) },
      },
    },
  },
});

const revealKey = members.defineRoute({
  method: 'get',
  path: '/things/{thingId}/key',
  operationId: 'revealKey',
  parameters: [thingId],
  responses: {
    200: {
      description: 'The key.',
      content: {
        'application/json': { schema: envelope(z.object({ key: sensitive(z.string()) })) },
      },
    },
  },
});

const smallBody = { content: { 'application/json': { schema: z.object({ text: z.string() }) } } };

const postNote = base
  .public()
  .bodyLimit(64)
  .defineRoute({
    method: 'post',
    path: '/notes',
    operationId: 'postNote',
    requestBody: smallBody,
    responses: {
      200: {
        description: 'Noted.',
        content: { 'application/json': { schema: envelope(z.object({ length: z.number() })) } },
      },
    },
  });

const postBatch = base
  .public()
  .bodyLimit(BATCH_BODY_LIMIT)
  .defineRoute({
    method: 'post',
    path: '/notes/batch',
    operationId: 'postBatch',
    requestBody: smallBody,
    responses: {
      200: {
        description: 'Noted.',
        content: { 'application/json': { schema: envelope(z.object({ length: z.number() })) } },
      },
    },
  });

const ping = base.public().defineRoute({
  method: 'get',
  path: '/ping',
  operationId: 'ping',
  responses: {
    200: {
      description: 'Pong.',
      content: { 'application/json': { schema: envelope(z.object({ pong: z.boolean() })) } },
    },
  },
});

const legacy = defineRoute({
  method: 'get',
  version: 1,
  path: '/legacy',
  operationId: 'legacy',
  responses: {
    200: {
      description: 'Bound before its module opted in.',
      content: { 'application/json': { schema: envelope(z.object({ ok: z.boolean() })) } },
    },
  },
});

const THING = '01a0e700-0000-7000-8000-000000000001';

@Controller()
class ThingsController {
  @Endpoint(readThing)
  public async readThing(
    @EndpointInput(readThing) { params, query, principal }: HandlerInput<typeof readThing>,
  ): Promise<{ thingId: string; readBy: string; verbose: boolean; revenue: number }> {
    return Promise.resolve({
      thingId: params.thingId,
      readBy: JSON.stringify(principal),
      verbose: query.verbose ?? false,
      revenue: 1200,
    });
  }

  @Endpoint(browseThings)
  public async browseThings(
    @EndpointPrincipal(browseThings) principal: HandlerInput<typeof browseThings>['principal'],
  ): Promise<{ anonymous: boolean; note: string }> {
    return Promise.resolve({ anonymous: principal === null, note: 'for members' });
  }

  @Endpoint(promoteThing)
  public async promoteThing(
    @EndpointInput(promoteThing) { body }: HandlerInput<typeof promoteThing>,
  ): Promise<{ reason: string }> {
    return Promise.resolve({ reason: body.reason });
  }

  @Endpoint(revealKey)
  public async revealKey(): Promise<{ key: string }> {
    return Promise.resolve({ key: 'sk_live' });
  }

  @Endpoint(postNote)
  public async postNote(
    @EndpointInput(postNote) { body }: HandlerInput<typeof postNote>,
  ): Promise<{ length: number }> {
    return Promise.resolve({ length: body.text.length });
  }

  @Endpoint(postBatch)
  public async postBatch(
    @EndpointInput(postBatch) { body }: HandlerInput<typeof postBatch>,
  ): Promise<{ length: number }> {
    return Promise.resolve({ length: body.text.length });
  }

  @Endpoint(ping)
  public async ping(@EndpointInput(ping) { principal }: HandlerInput<typeof ping>): Promise<{
    pong: boolean;
  }> {
    return Promise.resolve({ pong: principal === undefined });
  }

  @Endpoint(legacy)
  public async legacy(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }
}

@Module({ controllers: [ThingsController] })
class ThingsModule {}

interface MemberRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
}

let identified = 0;

const memberGuard: IdentityGuard = {
  identify: (context: ExecutionContext) => {
    identified += 1;
    const presented = context.switchToHttp().getRequest<MemberRequest>().headers[MEMBER_HEADER];
    if (presented === undefined) return Promise.resolve(null);
    if (presented === 'refused') throw unauthenticated();
    const rights = presented === 'owner' ? ['canRevenue', 'gold'] : [];
    return Promise.resolve({ accountId: presented, rights, sessionSecret: 'never served' });
  },
  responseHeadersFor: () => ({ 'x-arthome-rights-version': '7' }),
};

const tierGuard: RuleGuard = {
  check: (_context: ExecutionContext, rule: Requirement, principal: unknown) => {
    const { level } = rule.params as { readonly level: string };
    if ((principal as { readonly rights: readonly string[] }).rights.includes(level)) {
      return Promise.resolve();
    }
    throw new RefusalException(HttpStatus.FORBIDDEN, {
      code: ApiErrorCode.FORBIDDEN,
      params: {},
      nature: FailureNature.REFUSED,
    });
  },
};

function providersWith(guards: EndpointGuards) {
  const clock = new FixedClock(NOW);
  return [
    ...endpointProviders({ useValue: guards }),
    {
      provide: APP_PIPE,
      useValue: new StandardSchemaValidationPipe({ exceptionFactory: schemaInvalidException }),
    },
    {
      provide: APP_FILTER,
      inject: [HttpAdapterHost],
      useFactory: (host: HttpAdapterHost) => new ErrorEnvelopeFilter(host, clock),
    },
    { provide: APP_INTERCEPTOR, useValue: new SuccessEnvelopeInterceptor(clock) },
  ];
}

// The app runs with `logger: false`, which silences the output and not the calls. Read in
//   `beforeAll`: Vitest 5 clears a mock's calls before each test.
const warn = vi.spyOn(Logger.prototype, 'warn');
let bootWarnings: unknown[] = [];

let app: Awaited<ReturnType<typeof httpApp>>;

beforeAll(async () => {
  app = await httpApp({
    imports: [ThingsModule],
    providers: providersWith({
      identities: { member: memberGuard },
      rules: { tier: tierGuard },
    }),
    configure: serveEndpoints,
  });
  bootWarnings = warn.mock.calls.map(([message]): unknown => message);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  identified = 0;
});

function get(url: string, as?: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: as === undefined ? {} : { [MEMBER_HEADER]: as },
  });
}

describe('a route’s access, applied by Endpoint', () => {
  it('refuses a caller without the identity the route requires, as an unauthenticated one', async () => {
    const response = await get(`/v1/things/${THING}`);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: ApiErrorCode.UNAUTHENTICATED } });
  });

  it('refuses a credential the identity guard refuses, even on an optional route', async () => {
    expect((await get(`/v1/things/${THING}`, 'refused')).statusCode).toBe(401);
    expect((await get('/v1/things', 'refused')).statusCode).toBe(401);
  });

  it('hands the handler the principal the identity declares, and nothing more', async () => {
    const response = await get(`/v1/things/${THING}`, 'marie');

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.json<{ data: { readBy: string } }>().data.readBy)).toEqual({
      accountId: 'marie',
      rights: [],
    });
  });

  it('lets an anonymous caller into an optional route, with a null principal', async () => {
    const anonymous = await get('/v1/things');
    const signedIn = await get('/v1/things', 'marie');

    expect(anonymous.json()).toMatchObject({ data: { anonymous: true } });
    expect(signedIn.json()).toMatchObject({ data: { anonymous: false } });
  });

  it('asks no identity on a public route, whose principal is undefined', async () => {
    const response = await get('/v1/ping', 'marie');

    expect(response.json()).toMatchObject({ data: { pong: true } });
    expect(identified).toBe(0);
  });

  it('applies a rule after the identity, with the principal it resolved', async () => {
    const promote = (as: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/things/${THING}/promote`,
        headers: { [MEMBER_HEADER]: as },
        payload: { reason: 'season opener' },
      });

    expect((await promote('marie')).statusCode).toBe(403);
    expect((await promote('owner')).json()).toMatchObject({ data: { reason: 'season opener' } });
  });

  it('leaves a route without access to the legacy guards', async () => {
    expect((await get('/v1/legacy')).json()).toMatchObject({ data: { ok: true } });
    expect(identified).toBe(0);
  });
});

describe('EndpointInput', () => {
  it('validates every part against the route and names each failing field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/things/not-a-uuid/promote',
      headers: { [MEMBER_HEADER]: 'owner' },
      payload: { reason: '' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: ApiErrorCode.SCHEMA_INVALID, params: { fields: ['reason', 'thingId'] } },
    });
  });

  it('decodes the query from the wire', async () => {
    const response = await get(`/v1/things/${THING}?verbose=true`, 'marie');

    expect(response.json()).toMatchObject({ data: { verbose: true } });
  });
});

describe('the answer, projected and headed from the declaration', () => {
  it('removes a restricted field the caller lacks the right for, leaving no key behind', async () => {
    const other = await get(`/v1/things/${THING}`, 'marie');
    const owner = await get(`/v1/things/${THING}`, 'owner');

    expect(other.json<{ data: object }>().data).not.toHaveProperty('revenue');
    expect(owner.json()).toMatchObject({ data: { revenue: 1200 } });
  });

  it('gives every identified caller the signedIn right, and an anonymous one none', async () => {
    expect((await get('/v1/things')).json<{ data: object }>().data).not.toHaveProperty('note');
    expect((await get('/v1/things', 'marie')).json()).toMatchObject({
      data: { note: 'for members' },
    });
  });

  it('writes the freshness and the identity’s headers on a success', async () => {
    const response = await get(`/v1/things/${THING}`, 'marie');

    expect(response.headers['cache-control']).toBe('private, max-age=60');
    expect(response.headers.vary).toBe('X-Test-Member');
    expect(response.headers['x-arthome-rights-version']).toBe('7');
  });

  it('answers no-store when the answer holds a sensitive field', async () => {
    const response = await get(`/v1/things/${THING}/key`, 'marie');

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('writes no identity header for an anonymous caller', async () => {
    expect((await get('/v1/things')).headers).not.toHaveProperty('x-arthome-rights-version');
  });
});

describe('the body ceiling, the route’s', () => {
  const post = (url: string, text: string) =>
    app.inject({ method: 'POST', url, payload: { text } });

  it('refuses a body over the route’s own ceiling, below the default one', async () => {
    expect((await post('/v1/notes', 'a'.repeat(20))).statusCode).toBe(200);
    const refused = await post('/v1/notes', 'a'.repeat(100));

    expect(refused.statusCode).toBe(413);
    expect(refused.json()).toMatchObject({ error: { code: ApiErrorCode.PAYLOAD_TOO_LARGE } });
  });

  it('accepts a body over the default ceiling where the route raises it, as a batch does', async () => {
    const response = await post('/v1/notes/batch', 'a'.repeat(DEFAULT_BODY_LIMIT));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { length: DEFAULT_BODY_LIMIT } });
  });
});

describe('the boot', () => {
  it('lists the bound routes still without access', () => {
    expect(bootWarnings).toEqual(['Bound without access, under the legacy guards: legacy.']);
  });

  it('fails on an identity or a rule no guard is bound for, naming the route', async () => {
    await expect(
      httpApp({
        imports: [ThingsModule],
        providers: providersWith({ identities: {}, rules: { tier: tierGuard } }),
        configure: serveEndpoints,
      }),
    ).rejects.toThrow(/readThing \(identity member\)/);
    await expect(
      httpApp({
        imports: [ThingsModule],
        providers: providersWith({ identities: { member: memberGuard }, rules: {} }),
        configure: serveEndpoints,
      }),
    ).rejects.toThrow(/promoteThing \(rule tier\)/);
  });

  it('fails on a rule whose guard cannot enforce its parameters', async () => {
    const strict: RuleGuard = { ...tierGuard, problemWith: () => 'no tier named gold' };

    await expect(
      httpApp({
        imports: [ThingsModule],
        providers: providersWith({ identities: { member: memberGuard }, rules: { tier: strict } }),
        configure: serveEndpoints,
      }),
    ).rejects.toThrow(/promoteThing \(rule tier: no tier named gold\)/);
  });
});
