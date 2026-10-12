import { randomUUID } from 'node:crypto';

import {
  DeviceKind as WireDeviceKind,
  DeviceRevokedSchema,
  DeviceSessionClosedSchema,
  Surface as WireSurface,
} from '@arthome-platform/events';
import { fromBinary } from '@bufbuild/protobuf';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiErrorCode, FixedClock } from '@arthome/core';

import { DEVICE_REVOKED, DEVICE_SESSION_CLOSED } from './device-events.js';
import { BETTER_AUTH } from '../auth/auth.tokens.js';
import type { Auth } from '../auth/better-auth.js';
import {
  TRACEPARENT,
  callerOf,
  closeDeviceSession,
  deviceEventsOf,
  presenting,
  resolved,
  revokeDevice,
  signOut,
  signedIn,
  signedUp,
  type DeviceEventRow,
} from '../itest/device-acts.js';
import { startIdentity, type IdentityHarness } from '../itest/identity-app.js';

/**
 * PI2 over HTTP as the storefront BFF calls it: a revoked device closes every open binding on it
 *   with one event per account, a closed device session and a sign-out each say so once, and no
 *   account reaches another's device or session.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const clock = new FixedClock('2026-10-12T12:00:00.000Z');
let identity: IdentityHarness;

beforeAll(async () => {
  identity = await startIdentity('identity_device_revocation_itest', clock);
}, STARTUP_MS);

afterAll(async () => {
  await identity?.close();
});

function revokedOf(row: DeviceEventRow | undefined) {
  if (row === undefined) throw new Error('no device event was written');
  expect(row.type).toBe(DEVICE_REVOKED);
  return fromBinary(DeviceRevokedSchema, new Uint8Array(row.payload));
}

function closedOf(row: DeviceEventRow | undefined) {
  if (row === undefined) throw new Error('no device event was written');
  expect(row.type).toBe(DEVICE_SESSION_CLOSED);
  return fromBinary(DeviceSessionClosedSchema, new Uint8Array(row.payload));
}

async function revokedAt(deviceId: string): Promise<Date | null> {
  const [row] = await identity.dataSource.query<{ revoked_at: Date | null }[]>(
    'SELECT revoked_at FROM device WHERE id = $1',
    [deviceId],
  );
  return row?.revoked_at ?? null;
}

async function openBindingsOn(deviceId: string): Promise<number> {
  const [row] = await identity.dataSource.query<{ count: string }[]>(
    'SELECT count(*) FROM device_session WHERE device_id = $1 AND closed_at IS NULL',
    [deviceId],
  );
  return Number(row?.count);
}

async function authSessionIdsOf(accountId: string): Promise<string[]> {
  const { internalAdapter } = await identity.app.get<Auth>(BETTER_AUTH).$context;
  return (await internalAdapter.listSessions(accountId)).map(({ id }) => id);
}

describe('revoking a device', () => {
  it(
    'revokes it, closes its bindings, deletes their sessions and says so once, traced',
    async () => {
      const owner = await signedUp(identity);
      const { deviceId } = owner.session;
      const [authSessionId] = await authSessionIdsOf(owner.session.accountId);

      const response = await revokeDevice(identity, clock, callerOf(owner), deviceId);

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json<{ data: unknown }>().data).toEqual({ revoked: true });
      expect(await revokedAt(deviceId)).toEqual(new Date(clock.nowMs()));
      expect(await openBindingsOn(deviceId)).toBe(0);
      expect(await resolved(identity, owner.session.token)).toBeNull();
      expect(await authSessionIdsOf(owner.session.accountId)).not.toContain(authSessionId);

      const [row, ...others] = await deviceEventsOf(identity, deviceId);
      expect(others).toEqual([]);
      expect(row).toMatchObject({
        aggregatetype: 'identity.device',
        aggregateid: deviceId,
        tracecontext: TRACEPARENT,
        actor_id: owner.session.accountId,
      });
      expect(revokedOf(row)).toMatchObject({
        deviceId,
        accountId: owner.session.accountId,
        kind: WireDeviceKind.DESKTOP,
        revokedBy: { accountId: owner.session.accountId, surface: WireSurface.STOREFRONT_WEB },
      });
    },
    CASE_MS,
  );

  it(
    'writes one event per account holding the device',
    async () => {
      const owner = await signedUp(identity);
      const neighbour = await signedUp(identity);
      const onTheSameDevice = await signedIn(
        identity,
        neighbour.email,
        presenting(owner.device.token),
      );
      const { deviceId } = owner.session;
      expect(onTheSameDevice.session.deviceId).toBe(deviceId);

      expect((await revokeDevice(identity, clock, callerOf(owner), deviceId)).statusCode).toBe(200);

      const accounts = (await deviceEventsOf(identity, deviceId)).map(
        (row) => revokedOf(row).accountId,
      );
      expect(accounts.sort()).toEqual(
        [owner.session.accountId, neighbour.session.accountId].sort(),
      );
      expect(await resolved(identity, onTheSameDevice.session.token)).toBeNull();
      expect(await resolved(identity, neighbour.session.token)).not.toBeNull();
    },
    CASE_MS,
  );

  it(
    'answers 404 and writes nothing for a device the caller holds no session on, an unknown one or a revoked one',
    async () => {
      const owner = await signedUp(identity);
      const stranger = await signedUp(identity);
      const { deviceId } = owner.session;

      const refusals = [
        await revokeDevice(identity, clock, callerOf(stranger), deviceId),
        await revokeDevice(identity, clock, callerOf(owner), uuidv7()),
      ];
      expect(await revokedAt(deviceId)).toBeNull();
      expect(await deviceEventsOf(identity, deviceId)).toEqual([]);

      expect((await revokeDevice(identity, clock, callerOf(owner), deviceId)).statusCode).toBe(200);
      refusals.push(await revokeDevice(identity, clock, callerOf(owner), deviceId));

      for (const refusal of refusals) {
        expect(refusal.statusCode).toBe(404);
        expect(refusal.json<{ error: { code: string } }>().error.code).toBe(ApiErrorCode.NOT_FOUND);
      }
      expect(await deviceEventsOf(identity, deviceId)).toHaveLength(1);
    },
    CASE_MS,
  );

  it(
    'answers a replayed key with the first 200 and writes no second event',
    async () => {
      const owner = await signedUp(identity);
      const key = randomUUID();
      const { deviceId } = owner.session;

      const first = await revokeDevice(identity, clock, callerOf(owner), deviceId, key);
      const replay = await revokeDevice(identity, clock, callerOf(owner), deviceId, key);

      expect(replay.statusCode).toBe(200);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.json()).toEqual(first.json());
      expect(await deviceEventsOf(identity, deviceId)).toHaveLength(1);
    },
    CASE_MS,
  );

  it(
    'leaves neither the revocation nor its event when the transaction fails after the insert',
    async () => {
      const owner = await signedUp(identity);
      const { deviceId } = owner.session;
      await identity.dataSource.query(
        `CREATE FUNCTION refuse_device_event_itest() RETURNS trigger LANGUAGE plpgsql AS
           $$ BEGIN RAISE EXCEPTION 'the commit refused by the test'; END $$`,
      );
      // Deferred to the commit: the event and the rows are all written when it fails.
      await identity.dataSource.query(
        `CREATE CONSTRAINT TRIGGER refuse_device_event_itest AFTER INSERT ON outbox_event
           DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
           WHEN (NEW.aggregateid = '${deviceId}') EXECUTE FUNCTION refuse_device_event_itest()`,
      );
      try {
        const response = await revokeDevice(identity, clock, callerOf(owner), deviceId);
        expect(response.statusCode).toBe(500);
      } finally {
        await identity.dataSource.query(
          'DROP TRIGGER refuse_device_event_itest ON outbox_event; DROP FUNCTION refuse_device_event_itest()',
        );
      }

      expect(await deviceEventsOf(identity, deviceId)).toEqual([]);
      expect(await revokedAt(deviceId)).toBeNull();
      expect(await openBindingsOn(deviceId)).toBe(1);
      expect(await resolved(identity, owner.session.token)).not.toBeNull();
    },
    CASE_MS,
  );
});

describe('closing a device session', () => {
  it(
    'closes its own session once, self-initiated from the same device only',
    async () => {
      const viewer = await signedUp(identity);
      const { deviceId, deviceSessionId } = viewer.session;

      const closed = await closeDeviceSession(identity, clock, callerOf(viewer), deviceSessionId);
      expect(closed.statusCode).toBe(200);
      expect(closed.json<{ data: unknown }>().data).toEqual({ closed: true });
      expect(await resolved(identity, viewer.session.token)).toBeNull();

      const again = await closeDeviceSession(identity, clock, callerOf(viewer), deviceSessionId);
      expect(again.statusCode).toBe(200);
      expect(again.json<{ data: unknown }>().data).toEqual({ closed: true });

      const [row, ...others] = await deviceEventsOf(identity, deviceId);
      expect(others).toEqual([]);
      expect(row).toMatchObject({ tracecontext: TRACEPARENT, actor_id: viewer.session.accountId });
      expect(closedOf(row)).toMatchObject({
        deviceId,
        accountId: viewer.session.accountId,
        profileId: viewer.session.profile.id,
        selfInitiated: true,
        closedBy: { accountId: viewer.session.accountId, surface: WireSurface.STOREFRONT_WEB },
      });

      const elsewhere = await signedUp(identity);
      const fromAnotherDevice = { ...callerOf(elsewhere), deviceId: uuidv7() };
      expect(
        (
          await closeDeviceSession(
            identity,
            clock,
            fromAnotherDevice,
            elsewhere.session.deviceSessionId,
          )
        ).statusCode,
      ).toBe(200);
      const [fromElsewhere] = await deviceEventsOf(identity, elsewhere.session.deviceId);
      expect(closedOf(fromElsewhere).selfInitiated).toBe(false);
    },
    CASE_MS,
  );

  it(
    "answers 404 for another account's session or an unknown one, and closes nothing",
    async () => {
      const viewer = await signedUp(identity);
      const stranger = await signedUp(identity);

      for (const sessionId of [viewer.session.deviceSessionId, randomUUID()]) {
        const refusal = await closeDeviceSession(identity, clock, callerOf(stranger), sessionId);
        expect(refusal.statusCode).toBe(404);
        expect(refusal.json<{ error: { code: string } }>().error.code).toBe(ApiErrorCode.NOT_FOUND);
      }
      expect(await resolved(identity, viewer.session.token)).not.toBeNull();
      expect(await deviceEventsOf(identity, viewer.session.deviceId)).toEqual([]);
    },
    CASE_MS,
  );
});

describe('signing out', () => {
  it(
    'writes one self-initiated close, and none once the session is gone',
    async () => {
      const viewer = await signedUp(identity);
      const { deviceId } = viewer.session;

      expect((await signOut(identity, viewer.session.token)).statusCode).toBe(200);
      expect((await signOut(identity, viewer.session.token)).statusCode).toBe(200);

      const [row, ...others] = await deviceEventsOf(identity, deviceId);
      expect(others).toEqual([]);
      expect(row).toMatchObject({ tracecontext: TRACEPARENT, actor_id: viewer.session.accountId });
      expect(closedOf(row)).toMatchObject({
        deviceId,
        accountId: viewer.session.accountId,
        profileId: viewer.session.profile.id,
        selfInitiated: true,
        closedBy: { accountId: viewer.session.accountId, surface: WireSurface.STOREFRONT_WEB },
      });
    },
    CASE_MS,
  );

  it(
    'writes nothing when the same profile signs in again on the same device',
    async () => {
      const viewer = await signedUp(identity);
      const again = await signedIn(identity, viewer.email, presenting(viewer.device.token));

      expect(again.session.deviceId).toBe(viewer.session.deviceId);
      expect(await resolved(identity, viewer.session.token)).toBeNull();
      expect(await deviceEventsOf(identity, viewer.session.deviceId)).toEqual([]);
    },
    CASE_MS,
  );
});
