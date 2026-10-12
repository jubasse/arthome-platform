import { randomUUID } from 'node:crypto';

import { mintInternalToken } from '@arthome-platform/testing';
import { expect } from 'vitest';

import { DeviceKind, Locale, Service, Surface, type FixedClock } from '@arthome/core';

import type { IdentityHarness } from './identity-app.js';

export const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const PASSWORD = 'a-long-password';

export interface Presented {
  readonly token: string | null;
  readonly kind: string;
  readonly label: string;
}

export const BROWSER: Presented = { token: null, kind: DeviceKind.DESKTOP, label: 'Firefox' };

export interface SignedIn {
  readonly session: {
    readonly token: string;
    readonly accountId: string;
    readonly deviceId: string;
    readonly deviceSessionId: string;
    readonly profile: { readonly id: string };
  };
  readonly device: { readonly token: string | null };
}

/** Who calls: the internal token's `sub` and `did`. */
export interface DeviceCaller {
  readonly accountId: string;
  readonly deviceId: string;
}

export interface DeviceEventRow {
  readonly id: string;
  readonly aggregatetype: string;
  readonly aggregateid: string;
  readonly type: string;
  readonly payload: Buffer;
  readonly tracecontext: string | null;
  readonly actor_id: string | null;
  readonly created_at: Date;
}

export function presenting(token: string | null): Presented {
  return { ...BROWSER, token };
}

export function callerOf({ session }: SignedIn): DeviceCaller {
  return { accountId: session.accountId, deviceId: session.deviceId };
}

function post(
  identity: IdentityHarness,
  url: string,
  payload: object,
  headers: Record<string, string> = {},
) {
  return identity.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}

export async function signedUp(
  identity: IdentityHarness,
  device: Presented = BROWSER,
): Promise<SignedIn & { readonly email: string }> {
  const email = `revocation-${randomUUID()}@example.test`;
  const response = await post(
    identity,
    '/v1/auth/sign-up',
    {
      email,
      password: PASSWORD,
      displayName: 'Marie J.',
      locale: Locale.FR,
      country: 'FR',
      acceptedTermsVersion: 3,
      device,
    },
    { 'idempotency-key': randomUUID() },
  );
  expect(response.statusCode).toBe(201);
  return { ...response.json<{ data: SignedIn }>().data, email };
}

export async function signedIn(
  identity: IdentityHarness,
  email: string,
  device: Presented,
): Promise<SignedIn> {
  const response = await post(identity, '/v1/auth/sign-in', { email, password: PASSWORD, device });
  expect(response.statusCode).toBe(200);
  return response.json<{ data: SignedIn }>().data;
}

export async function resolved(identity: IdentityHarness, token: string): Promise<unknown> {
  const response = await post(identity, '/v1/sessions/resolve', { token });
  expect(response.statusCode).toBe(200);
  return response.json<{ data: { session: unknown } }>().data.session;
}

export function signOut(identity: IdentityHarness, token: string) {
  return post(
    identity,
    '/v1/sessions/revoke',
    { token },
    { traceparent: TRACEPARENT, 'x-arthome-actor-surface': Surface.STOREFRONT_WEB },
  );
}

async function actHeaders(clock: FixedClock, caller: DeviceCaller, key: string) {
  const token = await mintInternalToken({ service: Service.IDENTITY, clock, ...caller });
  return {
    authorization: `Bearer ${token}`,
    'idempotency-key': key,
    traceparent: TRACEPARENT,
    'x-arthome-actor-surface': Surface.STOREFRONT_WEB,
  };
}

export async function revokeDevice(
  identity: IdentityHarness,
  clock: FixedClock,
  caller: DeviceCaller,
  deviceId: string,
  key: string = randomUUID(),
) {
  return identity.app.inject({
    method: 'POST',
    url: `/v1/devices/${deviceId}/revoke`,
    headers: await actHeaders(clock, caller, key),
  });
}

export async function closeDeviceSession(
  identity: IdentityHarness,
  clock: FixedClock,
  caller: DeviceCaller,
  deviceSessionId: string,
  key: string = randomUUID(),
) {
  return identity.app.inject({
    method: 'POST',
    url: `/v1/device-sessions/${deviceSessionId}/close`,
    headers: await actHeaders(clock, caller, key),
  });
}

/** The device's events in the outbox, in the order identity wrote them. */
export function deviceEventsOf(
  identity: IdentityHarness,
  deviceId: string,
): Promise<DeviceEventRow[]> {
  return identity.dataSource.query<DeviceEventRow[]>(
    `SELECT id, aggregatetype, aggregateid, type, payload, tracecontext, actor_id, created_at
       FROM outbox_event
      WHERE aggregatetype = 'identity.device' AND aggregateid = $1
      ORDER BY created_at, id`,
    [deviceId],
  );
}
