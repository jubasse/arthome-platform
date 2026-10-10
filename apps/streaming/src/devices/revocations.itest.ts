import { Outcome } from '@arthome-platform/messaging';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IdentityErrorCode, PlaybackSessionState, plusSeconds } from '@arthome/core';

import {
  CASE_MS,
  STARTUP_MS,
  deviceRevoked,
  deviceSessionClosed,
  errorOf,
  grantSeat,
  identityId,
  liveDate,
  newViewer,
  onAnotherDevice,
  openCall,
  renewCall,
  sessionsOf,
  startPlayback,
  stopPlayback,
  ticketOf,
  type Playback,
  type Viewer,
} from '../itest/playback.js';

/**
 * Identity's device events through the consumer's reader and the real bus: a revoked device loses
 *   every lease, a closed profile session only the leases it opened there before the close.
 */

let playback: Playback;

beforeAll(async () => {
  playback = await startPlayback('streaming_revocations_itest');
}, STARTUP_MS);

afterAll(async () => {
  await stopPlayback(playback);
});

async function seatedDate(viewer: Viewer, seats = 1): Promise<string> {
  const dateId = await liveDate(playback);
  for (let seat = 0; seat < seats; seat += 1) await grantSeat(playback, viewer.accountId, dateId);
  return dateId;
}

describe('identity.device.revoked.v1', () => {
  it(
    "revokes every active lease of the account's device, on every date, and no other device's",
    async () => {
      const tv = newViewer();
      const phone = onAnotherDevice(tv);
      const first = await seatedDate(tv, 2);
      const second = await seatedDate(tv);
      const onFirst = ticketOf(await openCall(playback, tv, first));
      const onSecond = ticketOf(await openCall(playback, tv, second));
      const onPhone = ticketOf(await openCall(playback, phone, first));
      const message = deviceRevoked(tv.accountId, tv.deviceId, playback.clock.now());

      expect(await playback.apply(message)).toBe(Outcome.APPLIED);
      expect(await playback.apply(message)).toBe(Outcome.DUPLICATE);

      const sessions = await sessionsOf(playback, tv.accountId);
      expect(sessions.filter(({ device_id }) => device_id === tv.deviceId)).toEqual([
        expect.objectContaining({
          id: onFirst.sessionId,
          state: PlaybackSessionState.REVOKED,
          revoke_reason: IdentityErrorCode.SIGNED_OUT_ELSEWHERE,
        }),
        expect.objectContaining({
          id: onSecond.sessionId,
          state: PlaybackSessionState.REVOKED,
          revoke_reason: IdentityErrorCode.SIGNED_OUT_ELSEWHERE,
        }),
      ]);
      expect(sessions.find(({ id }) => id === onPhone.sessionId)?.state).toBe(
        PlaybackSessionState.ACTIVE,
      );

      const refused = await renewCall(playback, tv, onFirst.sessionId);
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused).code).toBe(IdentityErrorCode.SIGNED_OUT_ELSEWHERE);
    },
    CASE_MS,
  );

  it(
    'revokes nothing of another account holding the same device id',
    async () => {
      const tv = newViewer();
      const neighbour: Viewer = { ...newViewer(), deviceId: tv.deviceId };
      const dateId = await seatedDate(tv);
      await grantSeat(playback, neighbour.accountId, dateId);
      ticketOf(await openCall(playback, neighbour, dateId));

      await playback.apply(deviceRevoked(tv.accountId, tv.deviceId, playback.clock.now()));

      expect(await sessionsOf(playback, neighbour.accountId)).toEqual([
        expect.objectContaining({ state: PlaybackSessionState.ACTIVE }),
      ]);
    },
    CASE_MS,
  );
});

describe('identity.device_session.closed.v1', () => {
  it(
    "revokes the profile's leases on the device opened at or before the close, not a later one",
    async () => {
      const tv = newViewer();
      const otherProfile: Viewer = { ...tv, profileId: identityId() };
      const before = await seatedDate(tv);
      const after = await seatedDate(tv);
      const elsewhere = await seatedDate(tv);
      const opened = ticketOf(await openCall(playback, tv, before));
      const closedAt = plusSeconds(playback.clock.now(), 5);
      playback.clock.advance(10_000);
      const signedInAgain = ticketOf(await openCall(playback, tv, after));
      const otherOnTv = ticketOf(await openCall(playback, otherProfile, elsewhere));

      expect(await playback.apply(deviceSessionClosed(tv, closedAt))).toBe(Outcome.APPLIED);

      const states = Object.fromEntries(
        (await sessionsOf(playback, tv.accountId)).map(({ id, state }) => [id, state]),
      );
      expect(states).toEqual({
        [opened.sessionId]: PlaybackSessionState.REVOKED,
        [signedInAgain.sessionId]: PlaybackSessionState.ACTIVE,
        [otherOnTv.sessionId]: PlaybackSessionState.ACTIVE,
      });
      expect(errorOf(await renewCall(playback, tv, opened.sessionId)).code).toBe(
        IdentityErrorCode.SIGNED_OUT_ELSEWHERE,
      );
    },
    CASE_MS,
  );
});
