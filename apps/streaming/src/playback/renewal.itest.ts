import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ApiErrorCode,
  PLAYBACK_LEASE_SECONDS,
  PlaybackSessionState,
  RunState,
  WatchDenialReason,
} from '@arthome/core';

import {
  CASE_MS,
  STARTUP_MS,
  cancelSeat,
  declareInterrupted,
  errorOf,
  grantSeat,
  liveDate,
  newViewer,
  openCall,
  renewCall,
  sessionsOf,
  setRun,
  startPlayback,
  stopPlayback,
  ticketOf,
  type Playback,
  type Viewer,
} from '../itest/playback.js';

/**
 * A renewal re-reads every fact: each refusal revokes the lease with its reason, answered again to
 *   any later renewal of it, and a lapsed lease answers 404 so the player reopens.
 */

let playback: Playback;

beforeAll(async () => {
  playback = await startPlayback('streaming_renewal_itest');
}, STARTUP_MS);

afterAll(async () => {
  await stopPlayback(playback);
});

interface Playing {
  readonly viewer: Viewer;
  readonly dateId: string;
  readonly seatId: string;
  readonly sessionId: string;
}

async function playing(): Promise<Playing> {
  const viewer = newViewer();
  const dateId = await liveDate(playback);
  const seatId = await grantSeat(playback, viewer.accountId, dateId);
  const { sessionId } = ticketOf(await openCall(playback, viewer, dateId));
  playback.clock.advance(10_000);
  return { viewer, dateId, seatId, sessionId };
}

async function expectRevokedWith(
  { viewer, sessionId }: Playing,
  reason: string,
  options: { readonly country?: string } = {},
): Promise<void> {
  const refused = await renewCall(playback, viewer, sessionId, options);
  expect(refused.statusCode).toBe(403);
  expect(errorOf(refused).code).toBe(reason);
  expect(await sessionsOf(playback, viewer.accountId)).toEqual([
    expect.objectContaining({
      id: sessionId,
      state: PlaybackSessionState.REVOKED,
      revoke_reason: reason,
    }),
  ]);
  const again = await renewCall(playback, viewer, sessionId);
  expect(errorOf(again).code).toBe(reason);
}

describe('a renewal refused', () => {
  it(
    'revokes a lost seat with watch.seat_expired',
    async () => {
      const play = await playing();
      await cancelSeat(playback, play.seatId, play.viewer.accountId, play.dateId);
      await expectRevokedWith(play, WatchDenialReason.SEAT_EXPIRED);
    },
    CASE_MS,
  );

  it(
    'revokes an interrupted date with watch.date_interrupted, at the end of the renewal in progress',
    async () => {
      const play = await playing();
      await declareInterrupted(playback, play.dateId);
      await expectRevokedWith(play, WatchDenialReason.DATE_INTERRUPTED);
    },
    CASE_MS,
  );

  it(
    'revokes an ended live with watch.live_ended',
    async () => {
      const play = await playing();
      await setRun(playback, play.dateId, RunState.ENDED);
      await expectRevokedWith(play, WatchDenialReason.LIVE_ENDED);
    },
    CASE_MS,
  );

  it(
    'revokes any other refusal of decideWatch with its reason: a country the date excludes',
    async () => {
      const viewer = newViewer();
      const dateId = await liveDate(playback, { blackoutCountries: ['DE'] });
      await grantSeat(playback, viewer.accountId, dateId);
      const { sessionId } = ticketOf(await openCall(playback, viewer, dateId));

      await expectRevokedWith(
        { viewer, dateId, seatId: '', sessionId },
        WatchDenialReason.OUT_OF_TERRITORY,
        {
          country: 'DE',
        },
      );
    },
    CASE_MS,
  );

  it(
    'keeps playing under an incident veil: an interrupted run is still the live',
    async () => {
      const play = await playing();
      await setRun(playback, play.dateId, RunState.INTERRUPTED);
      expect((await renewCall(playback, play.viewer, play.sessionId)).statusCode).toBe(200);
    },
    CASE_MS,
  );
});

describe('a lapsed lease', () => {
  it(
    'answers 404 and is expired, so the player reopens and the decision runs again',
    async () => {
      const play = await playing();
      playback.clock.advance(PLAYBACK_LEASE_SECONDS * 1_000);

      const lapsed = await renewCall(playback, play.viewer, play.sessionId);

      expect(lapsed.statusCode).toBe(404);
      expect(errorOf(lapsed).code).toBe(ApiErrorCode.NOT_FOUND);
      expect(await sessionsOf(playback, play.viewer.accountId)).toEqual([
        expect.objectContaining({ id: play.sessionId, state: PlaybackSessionState.EXPIRED }),
      ]);
      const reopened = ticketOf(await openCall(playback, play.viewer, play.dateId));
      expect(reopened.sessionId).not.toBe(play.sessionId);
    },
    CASE_MS,
  );
});
