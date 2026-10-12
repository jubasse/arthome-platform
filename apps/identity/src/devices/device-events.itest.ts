import { Outcome } from '@arthome-platform/messaging';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IdentityErrorCode, PlaybackSessionState } from '@arthome/core';

import type { WireMessage } from '../../../streaming/src/itest/entitlement.js';
import {
  CASE_MS,
  STARTUP_MS,
  errorOf,
  grantSeat,
  liveDate,
  openCall,
  renewCall,
  sessionsOf,
  startPlayback,
  stopPlayback,
  ticketOf,
  type Playback,
  type Viewer,
} from '../../../streaming/src/itest/playback.js';
import {
  callerOf,
  closeDeviceSession,
  deviceEventsOf,
  presenting,
  revokeDevice,
  signOut,
  signedIn,
  signedUp,
  type DeviceEventRow,
  type SignedIn,
} from '../itest/device-acts.js';
import { startIdentity, type IdentityHarness } from '../itest/identity-app.js';

/**
 * Identity to streaming in one process: the rows identity's device acts write, shaped as
 *   `infra/debezium/identity-outbox.json` places their columns, read by streaming's consumer and
 *   acted on by its handlers. PE1 proves the same through the real connector and broker.
 */

let playback: Playback;
let identity: IdentityHarness;

beforeAll(async () => {
  playback = await startPlayback('identity_device_events_streaming_itest');
  // One clock for both: a profile's close is bounded by `occurred_at` against streaming's leases.
  identity = await startIdentity('identity_device_events_itest', playback.clock);
}, STARTUP_MS);

afterAll(async () => {
  await identity?.close();
  await stopPlayback(playback);
});

/** Debezium renders a NULL column as the four characters `null`. */
function routed(row: DeviceEventRow): WireMessage {
  const column = (value: string | null): string => value ?? 'null';
  return {
    topic: `arthome.${row.aggregatetype}`,
    key: row.aggregateid,
    value: row.payload,
    headers: {
      'message-id': row.id,
      type: row.type,
      traceparent: column(row.tracecontext),
      'actor-id': column(row.actor_id),
      'occurred-at': row.created_at.toISOString(),
    },
  };
}

/** The device's events past the first `delivered`, which streaming has applied already. */
async function deliveredFrom(deviceId: string, delivered = 0): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const row of (await deviceEventsOf(identity, deviceId)).slice(delivered)) {
    outcomes.push(await playback.apply(routed(row)));
  }
  return outcomes;
}

function viewerOf({ session }: SignedIn): Viewer {
  return {
    accountId: session.accountId,
    profileId: session.profile.id,
    deviceId: session.deviceId,
  };
}

/** Two accounts on one television, the first also on its own laptop, each playing one date. */
async function sharedTelevision() {
  const owner = await signedUp(identity);
  const ownerElsewhere = await signedIn(identity, owner.email, presenting(null));
  const neighbourAccount = await signedUp(identity);
  const neighbour = await signedIn(
    identity,
    neighbourAccount.email,
    presenting(owner.device.token),
  );
  expect(neighbour.session.deviceId).toBe(owner.session.deviceId);

  const dateId = await liveDate(playback);
  await grantSeat(playback, owner.session.accountId, dateId);
  await grantSeat(playback, owner.session.accountId, dateId);
  await grantSeat(playback, neighbour.session.accountId, dateId);
  const leases = {
    owner: ticketOf(await openCall(playback, viewerOf(owner), dateId)).sessionId,
    ownerElsewhere: ticketOf(await openCall(playback, viewerOf(ownerElsewhere), dateId)).sessionId,
    neighbour: ticketOf(await openCall(playback, viewerOf(neighbour), dateId)).sessionId,
  };
  return { owner, ownerElsewhere, neighbour, leases };
}

async function statesOf(...accountIds: string[]): Promise<Record<string, unknown>> {
  const rows = (await Promise.all(accountIds.map((id) => sessionsOf(playback, id)))).flat();
  return Object.fromEntries(
    rows.map(({ id, state, revoke_reason }) => [id, { state, revoke_reason }]),
  );
}

const REVOKED = {
  state: PlaybackSessionState.REVOKED,
  revoke_reason: IdentityErrorCode.SIGNED_OUT_ELSEWHERE,
};
const ACTIVE = { state: PlaybackSessionState.ACTIVE, revoke_reason: null };

async function expectRenewalRefused(viewer: Viewer, sessionId: string): Promise<void> {
  const refused = await renewCall(playback, viewer, sessionId);
  expect(refused.statusCode).toBe(403);
  expect(errorOf(refused).code).toBe(IdentityErrorCode.SIGNED_OUT_ELSEWHERE);
}

describe("identity's device events, read by streaming", () => {
  it(
    "a device revoked by one account ends that account's leases on it, the last one's too",
    async () => {
      const { owner, neighbour, leases } = await sharedTelevision();
      const { deviceId } = owner.session;

      expect(
        (await revokeDevice(identity, playback.clock, callerOf(owner), deviceId)).statusCode,
      ).toBe(200);
      expect(await deliveredFrom(deviceId)).toEqual([Outcome.APPLIED]);

      expect(await statesOf(owner.session.accountId, neighbour.session.accountId)).toEqual({
        [leases.owner]: REVOKED,
        [leases.neighbour]: ACTIVE,
        [leases.ownerElsewhere]: ACTIVE,
      });
      await expectRenewalRefused(viewerOf(owner), leases.owner);

      expect(
        (await revokeDevice(identity, playback.clock, callerOf(neighbour), deviceId)).statusCode,
      ).toBe(200);
      expect(await deliveredFrom(deviceId, 1)).toEqual([Outcome.APPLIED, Outcome.APPLIED]);

      expect(await statesOf(owner.session.accountId, neighbour.session.accountId)).toEqual({
        [leases.owner]: REVOKED,
        [leases.neighbour]: REVOKED,
        [leases.ownerElsewhere]: ACTIVE,
      });
      await expectRenewalRefused(viewerOf(neighbour), leases.neighbour);
    },
    CASE_MS,
  );

  it(
    "a closed device session ends that profile's leases on the device, not another account's",
    async () => {
      const { owner, neighbour, leases } = await sharedTelevision();

      const closed = await closeDeviceSession(
        identity,
        playback.clock,
        callerOf(owner),
        owner.session.deviceSessionId,
      );
      expect(closed.statusCode).toBe(200);
      expect(await deliveredFrom(owner.session.deviceId)).toEqual([Outcome.APPLIED]);

      expect(await statesOf(owner.session.accountId, neighbour.session.accountId)).toEqual({
        [leases.owner]: REVOKED,
        [leases.neighbour]: ACTIVE,
        [leases.ownerElsewhere]: ACTIVE,
      });
      await expectRenewalRefused(viewerOf(owner), leases.owner);
    },
    CASE_MS,
  );

  it(
    "a sign-out ends the profile's leases on the device it signed out of",
    async () => {
      const { owner, neighbour, leases } = await sharedTelevision();

      expect((await signOut(identity, owner.session.token)).statusCode).toBe(200);
      expect(await deliveredFrom(owner.session.deviceId)).toEqual([Outcome.APPLIED]);

      expect(await statesOf(owner.session.accountId, neighbour.session.accountId)).toEqual({
        [leases.owner]: REVOKED,
        [leases.neighbour]: ACTIVE,
        [leases.ownerElsewhere]: ACTIVE,
      });
      await expectRenewalRefused(viewerOf(owner), leases.owner);
    },
    CASE_MS,
  );
});
