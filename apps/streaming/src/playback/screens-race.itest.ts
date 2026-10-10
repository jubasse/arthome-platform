import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiErrorCode, PlaybackSessionState, WatchDenialReason } from '@arthome/core';

import { untilBlockedOrSettled } from '../itest/lock-waits.js';
import {
  CASE_MS,
  STARTUP_MS,
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
} from '../itest/playback.js';

/**
 * Two devices of one account opening at once on a ceiling of one: the screens' advisory lock
 *   serialises them, so the second takes the first over rather than both playing. A renewal
 *   waiting on that lock judges its caller on the row it then locks.
 */

let playback: Playback;

beforeAll(async () => {
  playback = await startPlayback('streaming_screens_race_itest');
}, STARTUP_MS);

afterAll(async () => {
  await stopPlayback(playback);
});

async function advisoryWaiters(): Promise<number> {
  const [row] = await playback.dataSource.query<{ waiting: number }[]>(
    `SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
  );
  return row?.waiting ?? 0;
}

describe('two openings at once on a ceiling of one', () => {
  it(
    'wait on the advisory lock, and end with exactly one active lease and the other revoked',
    async () => {
      const tv = newViewer();
      const phone = onAnotherDevice(tv);
      const dateId = await liveDate(playback);
      await grantSeat(playback, tv.accountId, dateId);

      const holder = playback.dataSource.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      await holder.query(
        `SELECT pg_advisory_xact_lock(hashtext('screens:' || $1::text || ':' || $2::text))`,
        [tv.accountId, dateId],
      );
      const openings = Promise.all([
        openCall(playback, tv, dateId),
        openCall(playback, phone, dateId),
      ]);
      try {
        await untilBlockedOrSettled(playback.dataSource, openings);
        expect(await advisoryWaiters()).toBeGreaterThan(0);
        expect(await sessionsOf(playback, tv.accountId)).toEqual([]);
      } finally {
        await holder.commitTransaction();
        await holder.release();
      }
      const answers = await openings;

      expect(answers.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
      const sessions = await sessionsOf(playback, tv.accountId);
      expect(sessions.map(({ state }) => state).sort()).toEqual([
        PlaybackSessionState.ACTIVE,
        PlaybackSessionState.REVOKED,
      ]);
      expect(sessions.find(({ state }) => state === PlaybackSessionState.REVOKED)).toMatchObject({
        revoke_reason: WatchDenialReason.CONCURRENT_LIMIT_REACHED,
      });
    },
    CASE_MS,
  );

  it(
    'end the same way when nothing else holds the lock',
    async () => {
      const tv = newViewer();
      const devices = [tv, onAnotherDevice(tv), onAnotherDevice(tv), onAnotherDevice(tv)];
      const dateId = await liveDate(playback);
      await grantSeat(playback, tv.accountId, dateId);

      const answers = await Promise.all(
        devices.map((device) => openCall(playback, device, dateId)),
      );

      expect(answers.map(({ statusCode }) => statusCode)).toEqual([200, 200, 200, 200]);
      const states = (await sessionsOf(playback, tv.accountId)).map(({ state }) => state);
      expect(states.filter((state) => state === PlaybackSessionState.ACTIVE)).toHaveLength(1);
      expect(states.filter((state) => state === PlaybackSessionState.REVOKED)).toHaveLength(3);
    },
    CASE_MS,
  );
});

describe('a renewal racing a resumption by another profile of the device', () => {
  it(
    'answers 403 on the locked row, not on the one it read before the lock',
    async () => {
      const tv = newViewer();
      const dateId = await liveDate(playback);
      await grantSeat(playback, tv.accountId, dateId);
      const { sessionId } = ticketOf(await openCall(playback, tv, dateId));

      const holder = playback.dataSource.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      await holder.query(
        `SELECT pg_advisory_xact_lock(hashtext('screens:' || $1::text || ':' || $2::text))`,
        [tv.accountId, dateId],
      );
      const renewal = renewCall(playback, tv, sessionId);
      try {
        await untilBlockedOrSettled(playback.dataSource, renewal);
        expect(await advisoryWaiters()).toBeGreaterThan(0);
        await holder.query('UPDATE playback_session SET profile_id = $2 WHERE id = $1', [
          sessionId,
          identityId(),
        ]);
      } finally {
        await holder.commitTransaction();
        await holder.release();
      }
      const answer = await renewal;

      expect(answer.statusCode).toBe(403);
      expect(errorOf(answer).code).toBe(ApiErrorCode.FORBIDDEN);
    },
    CASE_MS,
  );
});
