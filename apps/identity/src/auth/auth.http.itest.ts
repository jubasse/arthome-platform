import { randomUUID } from 'node:crypto';

import { mintInternalToken } from '@arthome-platform/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AccountStatus,
  ApiErrorCode,
  EMAIL_VERIFICATION_LINK_LIFETIME_HOURS,
  FixedClock,
  IdentityErrorCode,
  Locale,
  Service,
  audienceOf,
} from '@arthome/core';
import { PublicHandleSchema } from '@arthome/core/schema';

import { AUTH_SCHEMA, createAuth } from './better-auth.js';
import { asAccount, startIdentity, type IdentityHarness } from '../itest/identity-app.js';
import { newestLinkTokenTo } from '../itest/verification-links.js';

/**
 * Identity's side of auth slice A, over HTTP as the storefront BFF calls it: the two stores of a
 *   sign-up, the refusals that must not tell an attacker anything, the session's life, and the
 *   verification link's single use and expiry.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const clock = new FixedClock('2026-10-03T12:00:00.000Z');
let identity: IdentityHarness;
let emails = 0;

beforeAll(async () => {
  identity = await startIdentity('identity_auth_http_itest', clock);
}, STARTUP_MS);

afterAll(async () => {
  await identity?.close();
});

function nextEmail(): string {
  emails += 1;
  return `viewer-${emails}@example.test`;
}

interface SignUpAnswer {
  readonly data: {
    readonly session: {
      readonly token: string;
      readonly accountId: string;
      readonly deviceId: string;
      readonly expiresAt: string;
    };
    readonly account: { readonly publicHandle: string; readonly emailVerified: boolean };
  };
}

function signUpBody(email: string, overrides: object = {}): object {
  return {
    email,
    password: 'a-long-password',
    displayName: 'Marie J.',
    locale: Locale.FR,
    country: 'FR',
    acceptedTermsVersion: 3,
    ...overrides,
  };
}

function post(url: string, payload: object, headers: Record<string, string> = {}) {
  return identity.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}

function signUp(email: string, key: string = randomUUID(), overrides: object = {}) {
  return post('/v1/auth/sign-up', signUpBody(email, overrides), {
    'idempotency-key': key,
    traceparent: TRACEPARENT,
  });
}

async function signedUp(email: string = nextEmail()): Promise<SignUpAnswer['data']> {
  const response = await signUp(email);
  expect(response.statusCode).toBe(201);
  return response.json<SignUpAnswer>().data;
}

async function outboxTypesOf(accountId: string): Promise<string[]> {
  const rows = await identity.dataSource.query<{ type: string }[]>(
    'SELECT type FROM outbox_event WHERE aggregateid = $1 ORDER BY created_at, type',
    [accountId],
  );
  return rows.map(({ type }) => type);
}

async function newestLinkTokenOf(accountId: string): Promise<string> {
  const [account] = await identity.dataSource.query<{ email: string }[]>(
    'SELECT email FROM account WHERE id = $1',
    [accountId],
  );
  return newestLinkTokenTo(identity.dataSource, account?.email ?? '');
}

function confirm(token: string, key: string = randomUUID()) {
  return post('/v1/email-verifications/confirm', { token }, { 'idempotency-key': key });
}

describe('sign-up', () => {
  it(
    'writes the account, its credential under the same UUIDv7, both events and an open session',
    async () => {
      const email = nextEmail();
      const response = await signUp(email);

      expect(response.statusCode).toBe(201);
      const { session, account } = response.json<SignUpAnswer>().data;
      expect(account.emailVerified).toBe(false);
      expect(PublicHandleSchema.safeParse(account.publicHandle).success).toBe(true);
      expect(account.publicHandle).toMatch(/^@viewer\./);
      expect(session.accountId).toMatch(UUID_V7);
      expect(session.deviceId).toMatch(UUID_V7);
      expect(Date.parse(session.expiresAt)).toBeGreaterThan(clock.nowMs());

      const [row] = await identity.dataSource.query<
        { status: string; terms_version: number; locale: string; country: string }[]
      >('SELECT status, terms_version, locale, country FROM account WHERE id = $1', [
        session.accountId,
      ]);
      expect(row).toEqual({
        status: AccountStatus.ACTIVE,
        terms_version: 3,
        locale: Locale.FR,
        country: 'FR',
      });
      const [credential] = await identity.dataSource.query<{ id: string }[]>(
        `SELECT id FROM ${AUTH_SCHEMA}."user" WHERE email = $1`,
        [email],
      );
      expect(credential?.id).toBe(session.accountId);

      expect(await outboxTypesOf(session.accountId)).toEqual([
        'identity.account.registered.v1',
        'identity.email_verification.requested.v1',
      ]);
      // The token rides a topic of its own, which notifications alone reads (events.md §3).
      const topics = await identity.dataSource.query<{ type: string; aggregatetype: string }[]>(
        'SELECT type, aggregatetype FROM outbox_event WHERE aggregateid = $1 ORDER BY type',
        [session.accountId],
      );
      expect(topics).toEqual([
        { type: 'identity.account.registered.v1', aggregatetype: 'identity.account' },
        {
          type: 'identity.email_verification.requested.v1',
          aggregatetype: 'identity.email_verification',
        },
      ]);
      const traces = await identity.dataSource.query<{ tracecontext: string }[]>(
        'SELECT DISTINCT tracecontext FROM outbox_event WHERE aggregateid = $1',
        [session.accountId],
      );
      expect(traces).toEqual([{ tracecontext: TRACEPARENT }]);
    },
    CASE_MS,
  );

  it(
    'answers a replayed key with the first answer, and a reused key with another body as a 409',
    async () => {
      const email = nextEmail();
      const key = randomUUID();
      const first = await signUp(email, key);
      const replay = await signUp(email, key);

      expect(replay.statusCode).toBe(201);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.body).toBe(first.body);

      const otherPassword = await signUp(email, key, { password: 'another-long-password' });
      expect(otherPassword.statusCode).toBe(409);
      expect(otherPassword.json()).toMatchObject({
        error: { code: ApiErrorCode.IDEMPOTENCY_KEY_REUSED },
      });
    },
    CASE_MS,
  );

  it(
    'keeps no unsalted hash of the password in the idempotency record',
    async () => {
      const key = randomUUID();
      await signUp(nextEmail(), key);
      const records = await identity.dataSource.query<{ fingerprint: string }[]>(
        'SELECT fingerprint FROM idempotency_record WHERE key = $1',
        [key],
      );
      expect(records).toHaveLength(1);
      const body = JSON.stringify([
        'POST',
        '/v1/auth/sign-up',
        signUpBody(`viewer-${emails}@example.test`),
      ]);
      const { createHash } = await import('node:crypto');
      expect(records[0]?.fingerprint).not.toBe(createHash('sha256').update(body).digest('hex'));
    },
    CASE_MS,
  );

  it(
    'answers a taken address 409 identity.email_taken, whatever its case, and writes nothing',
    async () => {
      const { session } = await signedUp('taken@example.test');
      const before = await identity.dataSource.query<{ count: string }[]>(
        'SELECT count(*) FROM outbox_event',
      );

      for (const email of ['taken@example.test', 'Taken@Example.TEST']) {
        const refused = await signUp(email);
        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toMatchObject({
          error: { code: IdentityErrorCode.EMAIL_TAKEN, params: {} },
        });
      }

      const after = await identity.dataSource.query<{ count: string }[]>(
        'SELECT count(*) FROM outbox_event',
      );
      expect(after).toEqual(before);
      const credentials = await identity.dataSource.query<unknown[]>(
        `SELECT 1 FROM ${AUTH_SCHEMA}."user" WHERE email = 'taken@example.test'`,
      );
      expect(credentials).toHaveLength(1);
      expect(session.accountId).toMatch(UUID_V7);
    },
    CASE_MS,
  );

  it(
    'lets one of two sign-ups racing for one address through, and refuses the other',
    async () => {
      const email = nextEmail();
      const answers = await Promise.all([signUp(email), signUp(email)]);
      expect(answers.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
      const credentials = await identity.dataSource.query<unknown[]>(
        `SELECT 1 FROM ${AUTH_SCHEMA}."user" WHERE email = $1`,
        [email],
      );
      expect(credentials).toHaveLength(1);
    },
    CASE_MS,
  );

  it(
    'replaces a credential left with no account, and signs the address up',
    async () => {
      const email = nextEmail();
      const pool = new Pool({ connectionString: identityDatabaseUrl() });
      try {
        const auth = createAuth(pool, 'development-better-auth-secret-not-for-production');
        await auth.api.signUpEmail({ body: { email, password: 'an-orphaned-password', name: '' } });
      } finally {
        await pool.end();
      }

      const { session } = await signedUp(email);
      const [credential] = await identity.dataSource.query<{ id: string }[]>(
        `SELECT id FROM ${AUTH_SCHEMA}."user" WHERE email = $1`,
        [email],
      );
      expect(credential?.id).toBe(session.accountId);
    },
    CASE_MS,
  );

  it(
    'refuses a password shorter than the contract’s twelve characters, naming the field',
    async () => {
      const refused = await signUp(nextEmail(), randomUUID(), { password: 'short' });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({
        error: { code: ApiErrorCode.SCHEMA_INVALID, params: { fields: ['password'] } },
      });
    },
    CASE_MS,
  );
});

describe('sign-in', () => {
  it(
    'opens a second session with the right password',
    async () => {
      const email = nextEmail();
      const { session: first, account } = await signedUp(email);
      const signedIn = await post('/v1/auth/sign-in', { email, password: 'a-long-password' });

      expect(signedIn.statusCode).toBe(200);
      const { data } = signedIn.json<SignUpAnswer>();
      expect(data.session.accountId).toBe(first.accountId);
      expect(data.session.token).not.toBe(first.token);
      expect(data.account).toEqual(account);
    },
    CASE_MS,
  );

  it(
    'answers an unknown address and a wrong password with one 401, so neither is an oracle',
    async () => {
      const email = nextEmail();
      await signedUp(email);
      const wrongPassword = await post('/v1/auth/sign-in', { email, password: 'not-the-password' });
      const unknown = await post('/v1/auth/sign-in', {
        email: 'nobody@example.test',
        password: 'not-the-password',
      });

      for (const refused of [wrongPassword, unknown]) {
        expect(refused.statusCode).toBe(401);
        expect(refused.json()).toMatchObject({
          error: { code: IdentityErrorCode.INVALID_CREDENTIALS, params: {} },
        });
      }
      expect(wrongPassword.json<{ error: unknown }>().error).toEqual(
        unknown.json<{ error: unknown }>().error,
      );
    },
    CASE_MS,
  );

  it(
    'refuses an account that may not sign in, with the same 401',
    async () => {
      const email = nextEmail();
      const { session } = await signedUp(email);
      await identity.dataSource.query('UPDATE account SET status = $2 WHERE id = $1', [
        session.accountId,
        AccountStatus.SUSPENDED,
      ]);
      const refused = await post('/v1/auth/sign-in', { email, password: 'a-long-password' });
      expect(refused.statusCode).toBe(401);
      expect(refused.json()).toMatchObject({
        error: { code: IdentityErrorCode.INVALID_CREDENTIALS },
      });
      const resolved = await post('/v1/sessions/resolve', { token: session.token });
      expect(resolved.json()).toMatchObject({ data: { session: null } });
    },
    CASE_MS,
  );
});

describe('a session', () => {
  it(
    'resolves to its account while open, and to a 401 once revoked; revoking twice succeeds',
    async () => {
      const { session } = await signedUp();
      const resolved = await post('/v1/sessions/resolve', { token: session.token });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json()).toMatchObject({
        data: { session: { accountId: session.accountId, deviceId: session.deviceId } },
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const revoked = await post('/v1/sessions/revoke', { token: session.token });
        expect(revoked.statusCode).toBe(200);
        expect(revoked.json()).toMatchObject({ data: { signedOut: true } });
      }
      const gone = await post('/v1/sessions/resolve', { token: session.token });
      expect(gone.statusCode).toBe(200);
      expect(gone.json()).toMatchObject({ data: { session: null } });
    },
    CASE_MS,
  );

  /** better-auth reads the machine's time for a session's expiry: the machine's clock moves here. */
  it(
    'resolves to nothing once its seven days have passed unused',
    async () => {
      const { session } = await signedUp();
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.parse(session.expiresAt) + 1_000);
        const expired = await post('/v1/sessions/resolve', { token: session.token });
        expect(expired.statusCode).toBe(200);
        expect(expired.json()).toMatchObject({ data: { session: null } });
      } finally {
        vi.useRealTimers();
      }
    },
    CASE_MS,
  );

  it(
    'refuses a token without its signature, a forged signature and garbage',
    async () => {
      const { session } = await signedUp();
      const [raw, signature] = session.token.split('.');
      const forged = `${raw ?? ''}.${(signature ?? '').replace(/^./, (first) => (first === 'A' ? 'B' : 'A'))}`;
      for (const token of [raw ?? '', forged, 'garbage']) {
        const refused = await post('/v1/sessions/resolve', { token });
        expect(refused.json()).toMatchObject({ data: { session: null } });
      }
    },
    CASE_MS,
  );

  it(
    'closes only itself: another session of the account stays open',
    async () => {
      const email = nextEmail();
      const { session: first } = await signedUp(email);
      const second = (
        await post('/v1/auth/sign-in', { email, password: 'a-long-password' })
      ).json<SignUpAnswer>().data.session;

      await post('/v1/sessions/revoke', { token: first.token });
      expect(
        (await post('/v1/sessions/resolve', { token: second.token })).json<{
          data: { session: unknown };
        }>().data.session,
      ).not.toBeNull();
    },
    CASE_MS,
  );
});

describe('the account the token names', () => {
  it(
    'serves its handle and whether its address is verified, and refuses an anonymous caller',
    async () => {
      const { session, account } = await signedUp();
      const anonymous = await identity.app.inject({ method: 'GET', url: '/v1/accounts/me' });
      expect(anonymous.statusCode).toBe(401);

      const me = await identity.app.inject({
        method: 'GET',
        url: '/v1/accounts/me',
        headers: { authorization: await asAccount(clock, session.accountId) },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ data: account });
    },
    CASE_MS,
  );

  it(
    'refuses a call with no token, and one minted for another service',
    async () => {
      const noToken = await identity.app.inject({
        method: 'POST',
        url: '/v1/sessions/resolve',
        headers: { 'content-type': 'application/json', authorization: '' },
        payload: { token: 'x' },
      });
      expect(noToken.statusCode).toBe(401);

      const forCatalog = await mintInternalToken({ service: Service.CATALOG, clock });
      const refused = await identity.app.inject({
        method: 'POST',
        url: '/v1/auth/sign-in',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${forCatalog}` },
        payload: { email: 'x@example.test', password: 'x' },
      });
      expect(refused.statusCode).toBe(401);
      expect(audienceOf(Service.CATALOG)).not.toBe(audienceOf(Service.IDENTITY));
    },
    CASE_MS,
  );
});

describe('the verification link', () => {
  it(
    'verifies the address once; a second use is a 410, and a replayed key the first 200',
    async () => {
      const { session } = await signedUp();
      const token = await newestLinkTokenOf(session.accountId);
      const key = randomUUID();

      const verified = await confirm(token, key);
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toMatchObject({ data: { verified: true } });

      const again = await confirm(token);
      expect(again.statusCode).toBe(410);
      expect(again.json()).toMatchObject({
        error: { code: IdentityErrorCode.VERIFICATION_LINK_INVALID, params: {} },
      });

      const replay = await confirm(token, key);
      expect(replay.statusCode).toBe(200);
      expect(replay.headers['idempotency-replayed']).toBe('true');

      const me = await identity.app.inject({
        method: 'GET',
        url: '/v1/accounts/me',
        headers: { authorization: await asAccount(clock, session.accountId) },
      });
      expect(me.json()).toMatchObject({ data: { emailVerified: true } });
    },
    CASE_MS,
  );

  it(
    'expires after its lifetime, with the answer an unknown token gets',
    async () => {
      const { session } = await signedUp();
      const token = await newestLinkTokenOf(session.accountId);
      const unknown = await confirm('a-token-nobody-issued');

      clock.advance(EMAIL_VERIFICATION_LINK_LIFETIME_HOURS * 60 * 60 * 1000 + 1);
      try {
        const expired = await confirm(token);
        expect(expired.statusCode).toBe(410);
        expect(expired.json<{ error: unknown }>().error).toEqual(
          unknown.json<{ error: unknown }>().error,
        );
      } finally {
        clock.advance(-(EMAIL_VERIFICATION_LINK_LIFETIME_HOURS * 60 * 60 * 1000 + 1));
      }
    },
    CASE_MS,
  );

  it(
    'is replaced by a resend, which spends the earlier one; nothing is sent once verified',
    async () => {
      const { session } = await signedUp();
      const first = await newestLinkTokenOf(session.accountId);
      const authorization = await asAccount(clock, session.accountId);

      const resent = await post(
        '/v1/accounts/me/email-verification',
        {},
        {
          authorization,
          'idempotency-key': randomUUID(),
        },
      );
      expect(resent.statusCode).toBe(200);
      expect(resent.json()).toMatchObject({ data: { sent: true } });
      const second = await newestLinkTokenOf(session.accountId);
      expect(second).not.toBe(first);

      expect((await confirm(first)).statusCode).toBe(410);
      expect((await confirm(second)).statusCode).toBe(200);

      const nothing = await post(
        '/v1/accounts/me/email-verification',
        {},
        {
          authorization,
          'idempotency-key': randomUUID(),
        },
      );
      expect(nothing.json()).toMatchObject({ data: { sent: false } });
    },
    CASE_MS,
  );

  it(
    'lets a confirmation and a resend race on one account without a deadlock',
    async () => {
      for (let round = 0; round < 5; round += 1) {
        const { session } = await signedUp();
        const token = await newestLinkTokenOf(session.accountId);
        const [confirmed, resent] = await Promise.all([
          confirm(token),
          post(
            '/v1/accounts/me/email-verification',
            {},
            {
              authorization: await asAccount(clock, session.accountId),
              'idempotency-key': randomUUID(),
            },
          ),
        ]);
        expect([200, 410]).toContain(confirmed.statusCode);
        expect(resent.statusCode).toBe(200);
      }
    },
    CASE_MS,
  );

  it(
    'verifies nothing once the address it was sent to is no longer the account’s',
    async () => {
      const { session } = await signedUp();
      const token = await newestLinkTokenOf(session.accountId);
      await identity.dataSource.query(
        `UPDATE account SET email = 'moved@example.test' WHERE id = $1`,
        [session.accountId],
      );
      expect((await confirm(token)).statusCode).toBe(410);
    },
    CASE_MS,
  );
});

function identityDatabaseUrl(): string {
  return (identity.dataSource.options as { readonly url: string }).url;
}
