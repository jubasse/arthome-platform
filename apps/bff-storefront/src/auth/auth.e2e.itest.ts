import { randomUUID } from 'node:crypto';

import {
  startIdentity,
  type IdentityHarness,
} from '@arthome-platform/identity/src/itest/identity-app.js';
import { newestLinkTokenTo } from '@arthome-platform/identity/src/itest/verification-links.js';
import { startStack, type StartedStack } from '@arthome-platform/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SessionMode } from '@arthome/contracts/identity';
import {
  ApiErrorCode,
  AuthRateLimit,
  CHAT_ALLOWANCE_BY_SURFACE,
  FailureNature,
  FixedClock,
  IdentityErrorCode,
  Locale,
  Surface,
} from '@arthome/core';

import { VIEWER_COUNTRY_HEADER } from './auth.controller.js';
import { THROTTLER_REDIS, throttlerRedis } from './throttler-storage.js';
import { CLOCK } from '../clock.js';
import { IDENTITY_URL } from '../identity/identity.client.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../session/session-carriers.js';

/**
 * The storefront's authentication through this BFF and the real identity behind it: better-auth on
 *   Postgres, the internal token minted here and verified there, the caps counted in Redis. What
 *   identity decides on its own is its suites'; this one proves the relay, the modes, the cookie's
 *   hardening, the CSRF check and the caps.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;
const COUNTRY_HEADER = 'x-test-viewer-country';
const WEB = { 'x-arthome-surface': Surface.STOREFRONT_WEB };
const TV = { 'x-arthome-surface': Surface.STOREFRONT_TV };

// An hour ahead, as the other e2e suites, so no deadline falls due while a case runs; identity
//   verifies the BFF's tokens on the same clock.
const clock = new FixedClock(Date.now() + 3_600_000);

let identity: IdentityHarness;
let redis: StartedStack;
let app: NestFastifyApplication;
let addresses = 0;
let emails = 0;

beforeAll(async () => {
  identity = await startIdentity('bff_auth_e2e_identity', clock);
  await identity.app.listen({ port: 0, host: '127.0.0.1' });
  redis = await startStack({ redis: true, startupTimeoutMs: STARTUP_MS });

  const { AppModule } = await import('../app.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(IDENTITY_URL)
    .useValue(await identity.app.getUrl())
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(THROTTLER_REDIS)
    .useValue(throttlerRedis(redis.redis.url))
    .overrideProvider(VIEWER_COUNTRY_HEADER)
    .useValue(COUNTRY_HEADER)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, STARTUP_MS);

afterAll(async () => {
  await app?.close();
  await redis?.stop();
  await identity?.close();
});

/** Each case from its own address, so one case's caps never refuse another's requests. */
let address = '';
beforeEach(() => {
  addresses += 1;
  address = `10.0.${Math.floor(addresses / 250)}.${addresses % 250}`;
});

function nextEmail(): string {
  emails += 1;
  return `bff-viewer-${emails}@example.test`;
}

function signUpBody(email: string, mode: string, overrides: object = {}): object {
  return {
    email,
    password: 'a-long-password',
    mode,
    acceptedTermsVersion: 3,
    locale: Locale.FR,
    ...overrides,
  };
}

function post(
  url: string,
  payload: object | undefined,
  headers: Record<string, string> = {},
  from: string = address,
) {
  return app.inject({
    method: 'POST',
    url,
    remoteAddress: from,
    headers: {
      ...WEB,
      ...(payload !== undefined && { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(payload !== undefined && { payload }),
  });
}

function signUp(
  email: string,
  mode: string,
  key = randomUUID(),
  headers: Record<string, string> = {},
) {
  return post('/v1/auth/sign-up', signUpBody(email, mode), { 'idempotency-key': key, ...headers });
}

interface SetCookie {
  readonly name: string;
  readonly value: string;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: string;
  readonly path?: string;
  readonly maxAge?: number;
}

function cookiesOf(response: { cookies: unknown }): Map<string, SetCookie> {
  return new Map((response.cookies as SetCookie[]).map((cookie) => [cookie.name, cookie]));
}

/** A browser after a cookie-mode sign-up: its session cookie and the CSRF token it can read. */
async function browserSession(email: string = nextEmail()) {
  const signedUp = await signUp(email, SessionMode.COOKIE);
  expect(signedUp.statusCode).toBe(201);
  const cookies = cookiesOf(signedUp);
  const session = cookies.get(SESSION_COOKIE)?.value ?? '';
  const csrf = cookies.get(CSRF_COOKIE)?.value ?? '';
  const secret = [...cookies.values()].find(({ name }) => name.endsWith('csrf_secret'));
  const cookie = [
    `${SESSION_COOKIE}=${session}`,
    `${CSRF_COOKIE}=${csrf}`,
    ...(secret === undefined ? [] : [`${secret.name}=${secret.value}`]),
  ].join('; ');
  return { email, session, csrf, cookie };
}

async function bearerSession(email: string = nextEmail()) {
  const signedUp = await signUp(email, SessionMode.BEARER);
  expect(signedUp.statusCode).toBe(201);
  return signedUp.json<{ data: { accessToken: string } }>().data.accessToken;
}

function viewerContext(headers: Record<string, string>) {
  return app.inject({
    method: 'GET',
    url: '/v1/viewer-context',
    remoteAddress: address,
    headers: { ...WEB, ...headers },
  });
}

describe('signing up in cookie mode', () => {
  it(
    'sets a hardened session cookie and a readable CSRF one, and puts no token in the body',
    async () => {
      const signedUp = await signUp(nextEmail(), SessionMode.COOKIE);

      expect(signedUp.statusCode).toBe(201);
      const cookies = cookiesOf(signedUp);
      const session = cookies.get(SESSION_COOKIE);
      expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
      expect(session?.maxAge).toBeGreaterThan(6 * 24 * 60 * 60);
      expect(cookies.get(CSRF_COOKIE)).toMatchObject({ secure: true, sameSite: 'Lax', path: '/' });
      expect(cookies.get(CSRF_COOKIE)?.httpOnly).toBeFalsy();

      const { data } = signedUp.json<{ data: Record<string, unknown> }>();
      expect(data).toMatchObject({ mode: SessionMode.COOKIE });
      expect(Object.keys(data).sort()).toEqual(['mode', 'viewerContext']);
      expect(signedUp.body).not.toContain(session?.value ?? 'no session cookie');
    },
    CASE_MS,
  );

  it(
    'serves the viewer context, its constants the surface’s own',
    async () => {
      const { data } = (await signUp(nextEmail(), SessionMode.COOKIE, randomUUID(), TV)).json<{
        data: { viewerContext: Record<string, unknown> };
      }>();
      expect(data.viewerContext).toMatchObject({
        signedIn: true,
        currentProfileId: null,
        profiles: [],
        account: { emailVerified: false },
        constants: {
          chatRateLimitPerSecond:
            CHAT_ALLOWANCE_BY_SURFACE[Surface.STOREFRONT_TV].messagesPerSecond,
        },
      });
      expect(data.viewerContext).not.toHaveProperty('plan');
    },
    CASE_MS,
  );
});

describe('signing up in bearer mode', () => {
  it(
    'answers the token in the body and sets no cookie; a replayed key answers the same session',
    async () => {
      const email = nextEmail();
      const key = randomUUID();
      const first = await signUp(email, SessionMode.BEARER, key);

      expect(first.statusCode).toBe(201);
      expect(first.headers['set-cookie']).toBeUndefined();
      const { data } = first.json<{
        data: { mode: string; accessToken: string; refreshToken: null; expiresAt: string };
      }>();
      expect(data.mode).toBe(SessionMode.BEARER);
      expect(data.accessToken.length).toBeGreaterThan(20);
      expect(data.refreshToken).toBeNull();

      const replay = await signUp(email, SessionMode.BEARER, key);
      expect(replay.statusCode).toBe(201);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.json<{ data: { accessToken: string } }>().data.accessToken).toBe(
        data.accessToken,
      );
    },
    CASE_MS,
  );

  it(
    'records the country the gateway placed the visitor in, and the unknown region otherwise',
    async () => {
      const placed = nextEmail();
      const unplaced = nextEmail();
      await signUp(placed, SessionMode.BEARER, randomUUID(), { [COUNTRY_HEADER]: 'be' });
      await signUp(unplaced, SessionMode.BEARER);

      const rows = await identity.dataSource.query<{ email: string; country: string }[]>(
        'SELECT email, country FROM account WHERE email IN ($1, $2) ORDER BY email',
        [placed, unplaced],
      );
      expect(new Map(rows.map(({ email, country }) => [email, country]))).toEqual(
        new Map([
          [placed, 'BE'],
          [unplaced, 'ZZ'],
        ]),
      );
    },
    CASE_MS,
  );
});

describe('the refusals a surface is told', () => {
  it(
    'relays a taken address as identity.email_taken, refused',
    async () => {
      const email = nextEmail();
      await signUp(email, SessionMode.BEARER);
      const taken = await signUp(email, SessionMode.BEARER);

      expect(taken.statusCode).toBe(409);
      expect(taken.json()).toMatchObject({
        error: { code: IdentityErrorCode.EMAIL_TAKEN, nature: FailureNature.REFUSED },
      });
    },
    CASE_MS,
  );

  it(
    'answers a wrong password and an unknown address alike',
    async () => {
      const email = nextEmail();
      await signUp(email, SessionMode.BEARER);
      const wrong = await post('/v1/auth/sign-in', {
        email,
        password: 'not-the-password',
        mode: SessionMode.BEARER,
      });
      const unknown = await post('/v1/auth/sign-in', {
        email: 'nobody@example.test',
        password: 'not-the-password',
        mode: SessionMode.BEARER,
      });
      for (const refused of [wrong, unknown]) {
        expect(refused.statusCode).toBe(401);
        expect(refused.json()).toMatchObject({
          error: { code: IdentityErrorCode.INVALID_CREDENTIALS },
        });
      }
    },
    CASE_MS,
  );

  it(
    'refuses a call without a storefront surface before identity is asked',
    async () => {
      const refused = await post(
        '/v1/auth/sign-in',
        { email: nextEmail(), password: 'x', mode: SessionMode.BEARER },
        { 'x-arthome-surface': Surface.STUDIO_WEB },
      );
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({
        error: { code: ApiErrorCode.SCHEMA_INVALID, params: { fields: ['x-arthome-surface'] } },
      });
    },
    CASE_MS,
  );
});

describe('the caps', () => {
  it(
    'slows enumeration through sign-up: one address past its cap is refused, another is not',
    async () => {
      const { limit } = AuthRateLimit.SIGN_UP_PER_ADDRESS;
      for (let attempt = 0; attempt < limit; attempt += 1) {
        expect((await signUp(nextEmail(), SessionMode.BEARER)).statusCode).toBe(201);
      }
      const capped = await signUp(nextEmail(), SessionMode.BEARER);

      expect(capped.statusCode).toBe(429);
      expect(capped.json()).toMatchObject({
        error: { code: ApiErrorCode.RATE_LIMITED, nature: FailureNature.UNAVAILABLE },
      });
      const { retryAfterMs } = capped.json<{ error: { params: { retryAfterMs: number } } }>().error
        .params;
      expect(retryAfterMs).toBeGreaterThan(0);
      expect(capped.headers['retry-after-ms']).toBe(String(retryAfterMs));

      const elsewhere = await post(
        '/v1/auth/sign-up',
        signUpBody(nextEmail(), SessionMode.BEARER),
        { 'idempotency-key': randomUUID() },
        '10.9.9.9',
      );
      expect(elsewhere.statusCode).toBe(201);
    },
    CASE_MS,
  );

  it(
    'caps password guessing against one address whatever network it comes from',
    async () => {
      const email = nextEmail();
      await signUp(email, SessionMode.BEARER);
      const { limit } = AuthRateLimit.SIGN_IN_PER_EMAIL;
      for (let attempt = 0; attempt < limit; attempt += 1) {
        const refused = await post(
          '/v1/auth/sign-in',
          { email, password: 'not-the-password', mode: SessionMode.BEARER },
          {},
          `10.8.0.${attempt}`,
        );
        expect(refused.statusCode).toBe(401);
      }
      const capped = await post(
        '/v1/auth/sign-in',
        { email: email.toUpperCase(), password: 'a-long-password', mode: SessionMode.BEARER },
        {},
        '10.8.1.1',
      );
      expect(capped.statusCode).toBe(429);
    },
    CASE_MS,
  );
});

describe('a session in use', () => {
  it(
    'opens the viewer context by cookie, refreshing the cookie, and by bearer, setting none',
    async () => {
      const browser = await browserSession();
      const byCookie = await viewerContext({ cookie: browser.cookie });
      expect(byCookie.statusCode).toBe(200);
      expect(byCookie.headers['cache-control']).toBe('private, max-age=300');
      expect(cookiesOf(byCookie).get(SESSION_COOKIE)?.value).toBe(browser.session);

      const token = await bearerSession();
      const byBearer = await viewerContext({ authorization: `Bearer ${token}` });
      expect(byBearer.statusCode).toBe(200);
      expect(byBearer.headers['set-cookie']).toBeUndefined();
    },
    CASE_MS,
  );

  it(
    'is a 401 when absent, forged, or carried both ways at once',
    async () => {
      const token = await bearerSession();
      const browser = await browserSession();
      for (const headers of [
        {},
        { authorization: 'Bearer forged.token' },
        { authorization: `Basic ${token}` },
        { authorization: `Bearer ${token}`, cookie: browser.cookie },
      ]) {
        const refused = await viewerContext(headers);
        expect(refused.statusCode).toBe(401);
        expect(refused.json()).toMatchObject({ error: { code: ApiErrorCode.UNAUTHENTICATED } });
      }
    },
    CASE_MS,
  );
});

describe('a write with the session cookie', () => {
  it(
    'is refused without its CSRF token, with a wrong one, or with another session’s',
    async () => {
      const browser = await browserSession();
      const other = await browserSession();
      for (const csrf of [undefined, 'not-a-token', other.csrf]) {
        const refused = await post('/v1/auth/sign-out', undefined, {
          cookie: browser.cookie,
          'idempotency-key': randomUUID(),
          ...(csrf !== undefined && { [CSRF_HEADER]: csrf }),
        });
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toMatchObject({
          error: { code: ApiErrorCode.FORBIDDEN, nature: FailureNature.REFUSED },
        });
      }
      expect((await viewerContext({ cookie: browser.cookie })).statusCode).toBe(200);
    },
    CASE_MS,
  );

  it(
    'signs out with its token, clearing both cookies with the attributes that set them',
    async () => {
      const browser = await browserSession();
      const signedOut = await post('/v1/auth/sign-out', undefined, {
        cookie: browser.cookie,
        [CSRF_HEADER]: browser.csrf,
        'idempotency-key': randomUUID(),
      });

      expect(signedOut.statusCode).toBe(200);
      expect(signedOut.json()).toMatchObject({ data: { signedOut: true } });
      const cleared = cookiesOf(signedOut);
      expect(cleared.get(SESSION_COOKIE)).toMatchObject({
        value: '',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
      });
      expect(cleared.get(CSRF_COOKIE)).toMatchObject({ value: '', secure: true, path: '/' });
      expect((await viewerContext({ cookie: browser.cookie })).statusCode).toBe(401);
    },
    CASE_MS,
  );
});

describe('signing out by bearer', () => {
  it(
    'closes that session alone and succeeds again on a replay',
    async () => {
      const email = nextEmail();
      const first = await bearerSession(email);
      const second = (
        await post('/v1/auth/sign-in', {
          email,
          password: 'a-long-password',
          mode: SessionMode.BEARER,
        })
      ).json<{ data: { accessToken: string } }>().data.accessToken;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const signedOut = await post('/v1/auth/sign-out', undefined, {
          authorization: `Bearer ${first}`,
          'idempotency-key': randomUUID(),
        });
        expect(signedOut.statusCode).toBe(200);
      }
      expect((await viewerContext({ authorization: `Bearer ${first}` })).statusCode).toBe(401);
      expect((await viewerContext({ authorization: `Bearer ${second}` })).statusCode).toBe(200);
    },
    CASE_MS,
  );
});

describe('the verification link, through the BFF', () => {
  it(
    'verifies once, answers 410 to a second use, and the viewer context says so',
    async () => {
      const email = nextEmail();
      const token = await bearerSession(email);
      const link = await newestLinkTokenTo(identity.dataSource, email);

      const verified = await post(
        '/v1/auth/verify-email',
        { token: link },
        {
          'idempotency-key': randomUUID(),
        },
      );
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toMatchObject({ data: { verified: true } });

      const spent = await post(
        '/v1/auth/verify-email',
        { token: link },
        {
          'idempotency-key': randomUUID(),
        },
      );
      expect(spent.statusCode).toBe(410);
      expect(spent.json()).toMatchObject({
        error: { code: IdentityErrorCode.VERIFICATION_LINK_INVALID },
      });

      const context = await viewerContext({ authorization: `Bearer ${token}` });
      expect(context.json()).toMatchObject({ data: { account: { emailVerified: true } } });
    },
    CASE_MS,
  );

  it(
    'resends for the signed-in account, within the account’s cap',
    async () => {
      const token = await bearerSession();
      const { limit } = AuthRateLimit.EMAIL_VERIFICATION_RESEND_PER_ACCOUNT;
      for (let attempt = 0; attempt < limit; attempt += 1) {
        const resent = await post('/v1/auth/verify-email/resend', undefined, {
          authorization: `Bearer ${token}`,
          'idempotency-key': randomUUID(),
        });
        expect(resent.statusCode).toBe(200);
        expect(resent.json()).toMatchObject({ data: { sent: true } });
      }
      const capped = await post(
        '/v1/auth/verify-email/resend',
        undefined,
        { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
        '10.7.7.7',
      );
      expect(capped.statusCode).toBe(429);
    },
    CASE_MS,
  );
});
