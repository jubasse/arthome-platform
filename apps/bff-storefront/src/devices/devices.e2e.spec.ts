import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { serveEndpoints } from '@arthome-platform/http-edge';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ApiErrorCode,
  FailureNature,
  FixedClock,
  PLAYBACK_TOKEN_LIFETIME_SECONDS,
  Surface,
} from '@arthome/core';

import { AppModule } from '../app.module.js';
import { CLOCK } from '../clock.js';
import { IDENTITY_URL } from '../identity/identity.client.js';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  CSRF_SECRET_COOKIE,
  DEVICE_COOKIE,
  SESSION_COOKIE,
} from '../session/session-carriers.js';

/**
 * `revokeDevice` and `signOutProfile` through the whole app, against a stand-in identity that
 *   answers PI1's resolve (S3) and PI2's revocation and closing (S5, S6).
 */

const ACCOUNT = '01a0e700-0000-7000-8000-0000000000c1';
const DEVICE = '01a0e700-0000-7000-8000-0000000000d1';
const OTHER_DEVICE = '01a0e700-0000-7000-8000-0000000000d2';
const UNKNOWN_DEVICE = '01a0e700-0000-7000-8000-0000000000d9';
const DEVICE_SESSION = '01a0e700-0000-7000-8000-0000000000e1';
const OTHER_DEVICE_SESSION = '01a0e700-0000-7000-8000-0000000000e2';
const PROFILE = { id: '01a0e700-0000-7000-8000-0000000000f1', name: 'Marie', kind: 'adult' };
const COOKIE_TOKEN = 'sess_cookie';
const BEARER_TOKEN = 'sess_bearer';
const REPLAYED_KEY = '01a0e700-0000-7000-8000-00000000aaaa';

interface IdentityCall {
  readonly path: string;
  readonly idempotencyKey: string | undefined;
  readonly claims: Record<string, unknown>;
}

const calls: IdentityCall[] = [];
let identityStandIn: Server;
let app: NestFastifyApplication;

function answer(
  response: ServerResponse,
  status: number,
  body: object,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify({ servedAt: '2026-10-12T10:00:00.000Z', ...body }));
}

function bodyOf(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => resolve(body));
  });
}

beforeAll(async () => {
  identityStandIn = createServer((request, response) => {
    void bodyOf(request).then((body) => {
      const path = request.url ?? '';
      if (path === '/v1/sessions/resolve') {
        const { token } = JSON.parse(body) as { token: string };
        const session = [COOKIE_TOKEN, BEARER_TOKEN].includes(token)
          ? {
              accountId: ACCOUNT,
              deviceId: DEVICE,
              deviceSessionId: DEVICE_SESSION,
              expiresAt: '2026-11-05T10:00:00.000Z',
              profile: PROFILE,
              account: { publicHandle: '@marie', emailVerified: true },
            }
          : null;
        answer(response, 200, { data: { session } });
        return;
      }
      const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
      calls.push({
        path,
        idempotencyKey,
        claims: decodeJwt((request.headers.authorization ?? '').replace('Bearer ', '')),
      });
      if (path.includes(UNKNOWN_DEVICE)) {
        answer(response, 404, {
          error: {
            code: ApiErrorCode.NOT_FOUND,
            nature: FailureNature.REFUSED,
            params: {},
            traceId: '0af7651916cd43dd8448eb211c80319c',
          },
        });
        return;
      }
      const replayed = idempotencyKey === REPLAYED_KEY ? { 'idempotency-replayed': 'true' } : {};
      const data = path.startsWith('/v1/devices/') ? { revoked: true } : { closed: true };
      answer(response, 200, { data }, replayed);
    });
  });
  await new Promise<void>((resolve) => identityStandIn.listen(0, resolve));

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(IDENTITY_URL)
    .useValue(`http://localhost:${String((identityStandIn.address() as AddressInfo).port)}`)
    // An hour ahead, so no deadline falls due under load: search.e2e records why.
    .overrideProvider(CLOCK)
    .useValue(new FixedClock(Date.now() + 3_600_000))
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
  identityStandIn?.closeAllConnections();
  await new Promise((resolve) => identityStandIn.close(resolve));
});

beforeEach(() => {
  calls.length = 0;
});

const WEB = { 'x-arthome-surface': Surface.STOREFRONT_WEB };

interface SetCookie {
  readonly name: string;
  readonly value: string;
  readonly maxAge?: number;
}

function cookiesOf(response: { cookies: unknown }): Map<string, SetCookie> {
  return new Map((response.cookies as SetCookie[]).map((cookie) => [cookie.name, cookie]));
}

/** A browser signed in by cookie, with the CSRF pair `getViewerContext` hands it. */
async function browser(): Promise<{ readonly cookie: string; readonly csrf: string }> {
  const context = await app.inject({
    method: 'GET',
    url: '/v1/viewer-context',
    headers: WEB,
    cookies: { [SESSION_COOKIE]: COOKIE_TOKEN, [DEVICE_COOKIE]: 'device-token' },
  });
  expect(context.statusCode).toBe(200);
  const set = cookiesOf(context);
  const csrf = set.get(CSRF_COOKIE)?.value ?? '';
  const cookie = [
    `${SESSION_COOKIE}=${COOKIE_TOKEN}`,
    `${CSRF_COOKIE}=${csrf}`,
    `${CSRF_SECRET_COOKIE}=${set.get(CSRF_SECRET_COOKIE)?.value ?? ''}`,
    `${DEVICE_COOKIE}=device-token`,
  ].join('; ');
  return { cookie, csrf };
}

async function byCookie(url: string, key: string = randomUUID()) {
  const { cookie, csrf } = await browser();
  return app.inject({
    method: 'DELETE',
    url,
    headers: { ...WEB, cookie, [CSRF_HEADER]: csrf, 'idempotency-key': key },
  });
}

function byBearer(url: string, key: string = randomUUID()) {
  return app.inject({
    method: 'DELETE',
    url,
    headers: { ...WEB, authorization: `Bearer ${BEARER_TOKEN}`, 'idempotency-key': key },
  });
}

function cleared(response: { cookies: unknown }): string[] {
  return [...cookiesOf(response).values()]
    .filter((cookie) => cookie.value === '' || cookie.maxAge === 0)
    .map((cookie) => cookie.name)
    .sort();
}

describe('revokeDevice', () => {
  it('revokes at identity for the viewer, named by the token alone, and states the cut', async () => {
    const key = randomUUID();
    const response = await byBearer(`/v1/me/devices/${OTHER_DEVICE}`, key);

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      data: { playbackCutWithinSec: PLAYBACK_TOKEN_LIFETIME_SECONDS },
    });
    expect(calls).toEqual([
      {
        path: `/v1/devices/${OTHER_DEVICE}/revoke`,
        idempotencyKey: key,
        claims: expect.objectContaining({ sub: ACCOUNT, did: DEVICE, pro: PROFILE.id }) as object,
      },
    ]);
    expect(response.headers['idempotency-replayed']).toBeUndefined();
  });

  it('signs the browser out and forgets its device when it revokes its own', async () => {
    const response = await byCookie(`/v1/me/devices/${DEVICE}`);

    expect(response.statusCode).toBe(200);
    expect(cleared(response)).toEqual(
      [SESSION_COOKIE, CSRF_COOKIE, CSRF_SECRET_COOKIE, DEVICE_COOKIE].sort(),
    );
  });

  it('touches no cookie when the browser revokes another device', async () => {
    const response = await byCookie(`/v1/me/devices/${OTHER_DEVICE}`);

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('is refused without the CSRF token before identity hears of it', async () => {
    const { cookie } = await browser();
    calls.length = 0;
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/me/devices/${DEVICE}`,
      headers: { ...WEB, cookie, 'idempotency-key': randomUUID() },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: ApiErrorCode.FORBIDDEN } });
    expect(calls).toEqual([]);
  });

  it('is refused with another session’s CSRF token', async () => {
    const { cookie } = await browser();
    const other = await app.inject({
      method: 'GET',
      url: '/v1/viewer-context',
      headers: WEB,
      cookies: { [SESSION_COOKIE]: BEARER_TOKEN },
    });
    calls.length = 0;
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/me/devices/${DEVICE}`,
      headers: {
        ...WEB,
        cookie,
        [CSRF_HEADER]: cookiesOf(other).get(CSRF_COOKIE)?.value ?? '',
        'idempotency-key': randomUUID(),
      },
    });

    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('relays identity’s not found', async () => {
    const response = await byBearer(`/v1/me/devices/${UNKNOWN_DEVICE}`);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: ApiErrorCode.NOT_FOUND } });
  });

  it('marks a replayed key replayed', async () => {
    const response = await byBearer(`/v1/me/devices/${OTHER_DEVICE}`, REPLAYED_KEY);

    expect(response.statusCode).toBe(200);
    expect(response.headers['idempotency-replayed']).toBe('true');
    expect(calls[0]?.idempotencyKey).toBe(REPLAYED_KEY);
  });

  it('is refused without a session', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/me/devices/${DEVICE}`,
      headers: { ...WEB, 'idempotency-key': randomUUID() },
    });

    expect(response.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe('signOutProfile', () => {
  it('closes another device session at identity and answers the viewer’s context', async () => {
    const key = randomUUID();
    const response = await byCookie(`/v1/me/device-sessions/${OTHER_DEVICE_SESSION}`, key);

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.json()).toMatchObject({
      data: {
        deviceId: DEVICE,
        signedIn: true,
        currentProfileId: PROFILE.id,
        profiles: [PROFILE],
      },
    });
    expect(calls).toEqual([
      {
        path: `/v1/device-sessions/${OTHER_DEVICE_SESSION}/close`,
        idempotencyKey: key,
        claims: expect.objectContaining({ sub: ACCOUNT, did: DEVICE, pro: PROFILE.id }) as object,
      },
    ]);
  });

  it('signs the browser out of its own device session and keeps its device', async () => {
    const response = await byCookie(`/v1/me/device-sessions/${DEVICE_SESSION}`);

    expect(response.statusCode).toBe(200);
    expect(cleared(response)).toEqual([SESSION_COOKIE, CSRF_COOKIE, CSRF_SECRET_COOKIE].sort());
    expect(cookiesOf(response).has(DEVICE_COOKIE)).toBe(false);
    expect(response.json()).toMatchObject({
      data: {
        deviceId: DEVICE,
        signedIn: false,
        currentProfileId: null,
        profiles: [],
        account: null,
        constants: expect.any(Object) as object,
      },
    });
  });

  it('answers a bearer viewer its signed-out context and sets no cookie', async () => {
    const response = await byBearer(`/v1/me/device-sessions/${DEVICE_SESSION}`);

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.json()).toMatchObject({ data: { signedIn: false, deviceId: DEVICE } });
  });

  it('is refused without the CSRF token before identity hears of it', async () => {
    const { cookie } = await browser();
    calls.length = 0;
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/me/device-sessions/${DEVICE_SESSION}`,
      headers: { ...WEB, cookie, 'idempotency-key': randomUUID() },
    });

    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('relays identity’s not found', async () => {
    const response = await byBearer(`/v1/me/device-sessions/${UNKNOWN_DEVICE}`);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: ApiErrorCode.NOT_FOUND } });
  });

  it('marks a replayed key replayed', async () => {
    const response = await byBearer(`/v1/me/device-sessions/${OTHER_DEVICE_SESSION}`, REPLAYED_KEY);

    expect(response.headers['idempotency-replayed']).toBe('true');
    expect(calls[0]?.idempotencyKey).toBe(REPLAYED_KEY);
  });
});
