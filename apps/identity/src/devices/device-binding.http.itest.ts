import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AccountStatus, ApiErrorCode, DeviceKind, FixedClock, Locale } from '@arthome/core';

import { digestOf } from './device-token.js';
import { DevicesService } from './devices.service.js';
import { BETTER_AUTH } from '../auth/auth.tokens.js';
import { AUTH_SCHEMA, type Auth } from '../auth/better-auth.js';
import { startIdentity, type IdentityHarness } from '../itest/identity-app.js';

/**
 * PI1 over HTTP as the storefront BFF calls it: every session bound to a registered device and the
 *   account's default profile, the device token rotated at each sign-in, and a resolve that fails
 *   closed on a missing or closed binding and on a revoked device.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PASSWORD = 'a-long-password';

const clock = new FixedClock('2026-10-12T12:00:00.000Z');
let identity: IdentityHarness;
let emails = 0;

beforeAll(async () => {
  identity = await startIdentity('identity_device_binding_itest', clock);
}, STARTUP_MS);

afterAll(async () => {
  await identity?.close();
});

interface Profile {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

interface Answer {
  readonly session: {
    readonly token: string;
    readonly accountId: string;
    readonly deviceId: string;
    readonly deviceSessionId: string;
    readonly expiresAt: string;
    readonly profile: Profile;
  };
  readonly account: { readonly publicHandle: string; readonly emailVerified: boolean };
  readonly device: { readonly token: string | null };
}

interface Presented {
  readonly token: string | null;
  readonly kind: string;
  readonly label: string;
}

const BROWSER: Presented = { token: null, kind: DeviceKind.DESKTOP, label: 'Firefox on Linux' };

function nextEmail(): string {
  emails += 1;
  return `device-${emails}@example.test`;
}

function post(url: string, payload: object, headers: Record<string, string> = {}) {
  return identity.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}

function signUp(email: string, device?: Presented, key: string = randomUUID()) {
  return post(
    '/v1/auth/sign-up',
    {
      email,
      password: PASSWORD,
      displayName: 'Marie J.',
      locale: Locale.FR,
      country: 'FR',
      acceptedTermsVersion: 3,
      ...(device === undefined ? {} : { device }),
    },
    { 'idempotency-key': key },
  );
}

function signIn(email: string, device?: Presented, password: string = PASSWORD) {
  return post('/v1/auth/sign-in', {
    email,
    password,
    ...(device === undefined ? {} : { device }),
  });
}

async function signedUp(email: string = nextEmail(), device: Presented = BROWSER): Promise<Answer> {
  const response = await signUp(email, device);
  expect(response.statusCode).toBe(201);
  return response.json<{ data: Answer }>().data;
}

async function signedIn(email: string, device?: Presented): Promise<Answer> {
  const response = await signIn(email, device);
  expect(response.statusCode).toBe(200);
  return response.json<{ data: Answer }>().data;
}

async function resolved(token: string): Promise<unknown> {
  const response = await post('/v1/sessions/resolve', { token });
  expect(response.statusCode).toBe(200);
  return response.json<{ data: { session: unknown } }>().data.session;
}

async function deviceCount(): Promise<number> {
  const [row] = await identity.dataSource.query<{ count: string }[]>('SELECT count(*) FROM device');
  return Number(row?.count);
}

function presenting(token: string | null): Presented {
  return { ...BROWSER, token };
}

describe('sign-up', () => {
  it(
    'answers the registered device, its binding, the default profile and a token kept as a digest',
    async () => {
      const { session, device } = await signedUp();

      expect(session.deviceId).toMatch(UUID_V7);
      expect(session.deviceSessionId).toMatch(UUID_V4);
      expect(session.profile).toEqual({
        id: expect.any(String) as unknown,
        name: 'Marie J.',
        kind: 'adult',
      });
      expect(session.profile.id).toMatch(UUID_V4);
      expect(device.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const rows = await identity.dataSource.query<Record<string, unknown>[]>(
        'SELECT * FROM device WHERE id = $1',
        [session.deviceId],
      );
      expect(rows).toEqual([
        expect.objectContaining({
          token_hash: digestOf(device.token ?? ''),
          kind: DeviceKind.DESKTOP,
          label: 'Firefox on Linux',
          revoked_at: null,
        }),
      ]);
      expect(JSON.stringify(rows)).not.toContain(device.token);
    },
    CASE_MS,
  );

  it(
    'keeps no device token in the idempotency record',
    async () => {
      const key = randomUUID();
      const response = await signUp(nextEmail(), BROWSER, key);
      const { device } = response.json<{ data: Answer }>().data;
      const [record] = await identity.dataSource.query<{ response_body: unknown }[]>(
        'SELECT response_body FROM idempotency_record WHERE key = $1',
        [key],
      );
      expect(JSON.stringify(record?.response_body)).not.toContain('token');
      expect(JSON.stringify(record?.response_body)).not.toContain(device.token);
    },
    CASE_MS,
  );

  it(
    'registers a desktop named `unknown` when the body carries no device',
    async () => {
      const response = await signUp(nextEmail());
      expect(response.statusCode).toBe(201);
      const { session } = response.json<{ data: Answer }>().data;
      const [row] = await identity.dataSource.query<{ kind: string; label: string }[]>(
        'SELECT kind, label FROM device WHERE id = $1',
        [session.deviceId],
      );
      expect(row).toEqual({ kind: DeviceKind.DESKTOP, label: 'unknown' });
    },
    CASE_MS,
  );

  it(
    'refuses a device of an unknown kind and a label over 80 characters, naming the field',
    async () => {
      for (const [device, field] of [
        [{ ...BROWSER, kind: 'fridge' }, 'kind'],
        [{ ...BROWSER, label: 'x'.repeat(81) }, 'label'],
        [{ ...BROWSER, label: '' }, 'label'],
      ] as const) {
        const refused = await signUp(nextEmail(), device);
        expect(refused.statusCode).toBe(400);
        expect(refused.json()).toMatchObject({
          error: {
            code: ApiErrorCode.SCHEMA_INVALID,
            params: { issues: [{ path: ['device', field] }] },
          },
        });
      }
    },
    CASE_MS,
  );

  it(
    'answers a replay with the same ids and no device token while the session lives, whatever device the replay presents',
    async () => {
      const email = nextEmail();
      const key = randomUUID();
      const first = (await signUp(email, BROWSER, key)).json<{ data: Answer }>().data;
      const replay = await signUp(email, presenting(first.device.token), key);

      expect(replay.statusCode).toBe(201);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      const replayed = replay.json<{ data: Answer }>().data;
      expect(replayed.session).toEqual(first.session);
      expect(replayed.account).toEqual(first.account);
      expect(replayed.device).toEqual({ token: null });
    },
    CASE_MS,
  );

  it(
    'binds the session a replay re-opens to the recorded device and profile, or to a new device once revoked',
    async () => {
      const email = nextEmail();
      const key = randomUUID();
      const first = (await signUp(email, BROWSER, key)).json<{ data: Answer }>().data;
      await post('/v1/sessions/revoke', { token: first.session.token });

      const reopened = (await signUp(email, BROWSER, key)).json<{ data: Answer }>().data;
      expect(reopened.session.token).not.toBe(first.session.token);
      expect(reopened.session).toMatchObject({
        accountId: first.session.accountId,
        deviceId: first.session.deviceId,
        profile: first.session.profile,
      });
      expect(reopened.session.deviceSessionId).not.toBe(first.session.deviceSessionId);
      expect(reopened.device).toEqual({ token: null });
      expect(await resolved(reopened.session.token)).toMatchObject({
        deviceId: first.session.deviceId,
        deviceSessionId: reopened.session.deviceSessionId,
      });

      await post('/v1/sessions/revoke', { token: reopened.session.token });
      await identity.dataSource.query('UPDATE device SET revoked_at = now() WHERE id = $1', [
        first.session.deviceId,
      ]);
      const onNewDevice = (await signUp(email, BROWSER, key)).json<{ data: Answer }>().data;
      expect(onNewDevice.session.deviceId).toMatch(UUID_V7);
      expect(onNewDevice.session.deviceId).not.toBe(first.session.deviceId);
      expect(onNewDevice.session.profile).toEqual(first.session.profile);
      expect(await resolved(onNewDevice.session.token)).not.toBeNull();
    },
    CASE_MS,
  );
});

describe('sign-in', () => {
  it(
    'keeps the presented device and rotates its token; the old token then registers a new device',
    async () => {
      const email = nextEmail();
      const { session: first, device } = await signedUp(email);

      const second = await signedIn(email, presenting(device.token));
      expect(second.session.deviceId).toBe(first.deviceId);
      expect(second.session.profile).toEqual(first.profile);
      expect(second.device.token).not.toBeNull();
      expect(second.device.token).not.toBe(device.token);
      const [row] = await identity.dataSource.query<{ token_hash: string }[]>(
        'SELECT token_hash FROM device WHERE id = $1',
        [first.deviceId],
      );
      expect(row?.token_hash).toBe(digestOf(second.device.token ?? ''));

      const third = await signedIn(email, presenting(device.token));
      expect(third.session.deviceId).not.toBe(first.deviceId);
      expect(third.session.deviceId).toMatch(UUID_V7);
    },
    CASE_MS,
  );

  it(
    'registers a new device for an unknown, an expired or a revoked token, and still signs in',
    async () => {
      const email = nextEmail();
      const { session, device } = await signedUp(email);

      const unknown = await signedIn(email, presenting('a-token-nobody-issued'));
      expect(unknown.session.deviceId).not.toBe(session.deviceId);

      const expiringEmail = nextEmail();
      const expiring = await signedUp(expiringEmail);
      await identity.dataSource.query('UPDATE device SET token_expires_at = $2 WHERE id = $1', [
        expiring.session.deviceId,
        new Date(clock.nowMs() - 1_000),
      ]);
      const expired = await signIn(expiringEmail, presenting(expiring.device.token));
      expect(expired.statusCode).toBe(200);
      expect(expired.json<{ data: Answer }>().data.session.deviceId).not.toBe(
        expiring.session.deviceId,
      );

      await identity.dataSource.query('UPDATE device SET revoked_at = now() WHERE id = $1', [
        session.deviceId,
      ]);
      const revoked = await signedIn(email, presenting(device.token));
      expect(revoked.session.deviceId).not.toBe(session.deviceId);
    },
    CASE_MS,
  );

  it(
    'writes no device for a wrong password, nor for an account that may not sign in',
    async () => {
      const email = nextEmail();
      const { session, device } = await signedUp(email);
      const before = await deviceCount();
      const [{ token_hash } = { token_hash: '' }] = await identity.dataSource.query<
        { token_hash: string }[]
      >('SELECT token_hash FROM device WHERE id = $1', [session.deviceId]);

      const wrong = await signIn(email, presenting(device.token), 'not-the-password');
      expect(wrong.statusCode).toBe(401);
      expect(await deviceCount()).toBe(before);

      await identity.dataSource.query('UPDATE account SET status = $2 WHERE id = $1', [
        session.accountId,
        AccountStatus.SUSPENDED,
      ]);
      const suspended = await signIn(email, presenting(device.token));
      expect(suspended.statusCode).toBe(401);
      expect(await deviceCount()).toBe(before);
      const [after] = await identity.dataSource.query<{ token_hash: string }[]>(
        'SELECT token_hash FROM device WHERE id = $1',
        [session.deviceId],
      );
      expect(after?.token_hash).toBe(token_hash);
    },
    CASE_MS,
  );

  it(
    'replaces the binding of a second sign-in of one profile on one device',
    async () => {
      const email = nextEmail();
      const { session: first, device } = await signedUp(email);
      const second = await signedIn(email, presenting(device.token));

      expect(second.session.deviceId).toBe(first.deviceId);
      expect(await resolved(first.token)).toBeNull();
      expect(await resolved(second.session.token)).not.toBeNull();
      const bindings = await identity.dataSource.query<{ id: string; closed: boolean }[]>(
        `SELECT id, closed_at IS NOT NULL AS closed FROM device_session
          WHERE device_id = $1 ORDER BY opened_at, closed_at NULLS LAST`,
        [first.deviceId],
      );
      expect(bindings).toEqual(
        expect.arrayContaining([
          { id: first.deviceSessionId, closed: true },
          { id: second.session.deviceSessionId, closed: false },
        ]),
      );
      const replaced = await identity.dataSource.query<unknown[]>(
        `SELECT 1 FROM ${AUTH_SCHEMA}.session s
           JOIN device_session ds ON ds.auth_session_id = s.id
          WHERE ds.id = $1`,
        [first.deviceSessionId],
      );
      expect(replaced).toEqual([]);
    },
    CASE_MS,
  );

  it(
    'lets two sign-ins presenting one token through: one rotates it, the other registers a new device',
    async () => {
      const email = nextEmail();
      const { session, device } = await signedUp(email);
      const answers = await Promise.all([
        signIn(email, presenting(device.token)),
        signIn(email, presenting(device.token)),
      ]);

      expect(answers.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
      const [one, other] = answers.map((answer) => answer.json<{ data: Answer }>().data);
      const deviceIds = [one?.session.deviceId, other?.session.deviceId];
      expect(deviceIds.filter((id) => id === session.deviceId)).toHaveLength(1);
      expect(one?.device.token).not.toBe(other?.device.token);
      const [row] = await identity.dataSource.query<{ token_hash: string }[]>(
        'SELECT token_hash FROM device WHERE id = $1',
        [session.deviceId],
      );
      const keeper = one?.session.deviceId === session.deviceId ? one : other;
      expect(row?.token_hash).toBe(digestOf(keeper?.device.token ?? ''));
    },
    CASE_MS,
  );
});

describe('a session', () => {
  it(
    'resolves to its device, its binding, its profile and its account',
    async () => {
      const { session, account } = await signedUp();
      expect(await resolved(session.token)).toEqual({
        accountId: session.accountId,
        deviceId: session.deviceId,
        deviceSessionId: session.deviceSessionId,
        expiresAt: session.expiresAt,
        profile: session.profile,
        account,
      });
    },
    CASE_MS,
  );

  it(
    'resolves to nothing once revoked, and its binding is closed',
    async () => {
      const { session } = await signedUp();
      const revoked = await post('/v1/sessions/revoke', { token: session.token });
      expect(revoked.json()).toMatchObject({ data: { signedOut: true } });
      expect(await resolved(session.token)).toBeNull();
      const [binding] = await identity.dataSource.query<{ closed: boolean }[]>(
        'SELECT closed_at IS NOT NULL AS closed FROM device_session WHERE id = $1',
        [session.deviceSessionId],
      );
      expect(binding).toEqual({ closed: true });
    },
    CASE_MS,
  );

  it(
    'resolves to nothing once its device is revoked, or its binding closed',
    async () => {
      const onRevokedDevice = (await signedUp()).session;
      await identity.dataSource.query('UPDATE device SET revoked_at = now() WHERE id = $1', [
        onRevokedDevice.deviceId,
      ]);
      expect(await resolved(onRevokedDevice.token)).toBeNull();

      const withClosedBinding = (await signedUp()).session;
      await identity.dataSource.query('UPDATE device_session SET closed_at = now() WHERE id = $1', [
        withClosedBinding.deviceSessionId,
      ]);
      expect(await resolved(withClosedBinding.token)).toBeNull();
    },
    CASE_MS,
  );

  it(
    'resolves to nothing when it has no binding, as every session opened before PI1',
    async () => {
      const { session } = await signedUp();
      const { internalAdapter, secret } = await identity.app.get<Auth>(BETTER_AUTH).$context;
      const unbound = await internalAdapter.createSession(session.accountId);
      const { createHmac } = await import('node:crypto');
      const token = `${unbound.token}.${createHmac('sha256', secret).update(unbound.token).digest('base64')}`;
      expect(await resolved(token)).toBeNull();
    },
    CASE_MS,
  );
});

describe('the binding of one (device, profile)', () => {
  it(
    'stays single when two binds race: the later one replaces the earlier',
    async () => {
      const { session } = await signedUp();
      const devices = identity.app.get(DevicesService);
      const binds = await Promise.all(
        ['racing-session-a', 'racing-session-b'].map((authSessionId) =>
          identity.dataSource.transaction((manager) =>
            devices.bind(manager, {
              authSessionId: `${authSessionId}-${session.deviceSessionId}`,
              deviceId: session.deviceId,
              accountId: session.accountId,
              profileId: session.profile.id,
            }),
          ),
        ),
      );

      expect(binds).toHaveLength(2);
      const open = await identity.dataSource.query<{ id: string }[]>(
        'SELECT id FROM device_session WHERE device_id = $1 AND closed_at IS NULL',
        [session.deviceId],
      );
      expect(open).toHaveLength(1);
      expect(binds.map(({ deviceSessionId }) => deviceSessionId)).toContain(open[0]?.id);
    },
    CASE_MS,
  );
});

describe('the logs', () => {
  it(
    'hold neither a device token nor a session token across sign-up, sign-in, a replay and resolve',
    async () => {
      const levels = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const;
      const spies = [
        ...levels.map((level) => vi.spyOn(Logger.prototype, level)),
        ...levels.map((level) => vi.spyOn(Logger, level)),
        ...(['log', 'error', 'warn', 'info', 'debug'] as const).map((level) =>
          vi.spyOn(console, level),
        ),
      ];
      try {
        const email = nextEmail();
        const key = randomUUID();
        const first = (await signUp(email, BROWSER, key)).json<{ data: Answer }>().data;
        const replay = (await signUp(email, BROWSER, key)).json<{ data: Answer }>().data;
        const second = await signedIn(email, presenting(first.device.token));
        await resolved(second.session.token);
        await signIn(email, presenting(second.device.token), 'not-the-password');

        const secrets = [
          first.device.token,
          first.session.token,
          replay.session.token,
          second.device.token,
          second.session.token,
        ].filter((secret): secret is string => secret !== null);
        const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
        for (const secret of secrets) {
          expect(logged).not.toContain(secret);
          expect(logged).not.toContain(secret.split('.')[0]);
        }
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    },
    CASE_MS,
  );
});
