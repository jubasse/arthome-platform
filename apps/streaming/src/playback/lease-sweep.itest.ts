import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PLAYBACK_LEASE_SECONDS, PlaybackSessionState } from '@arthome/core';

import {
  CASE_MS,
  STARTUP_MS,
  grantSeat,
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
 * The sweeper's lease-expiry pass: lapsed leases `expired`, a batch at a time, the rows an
 *   opening or a renewal holds skipped until the next pass.
 */

let playback: Playback;

beforeAll(async () => {
  playback = await startPlayback('streaming_lease_sweep_itest');
}, STARTUP_MS);

afterAll(async () => {
  await stopPlayback(playback);
});

async function lapsedAndRenewed() {
  const tv = newViewer();
  const phone = onAnotherDevice(tv);
  const dateId = await liveDate(playback);
  await grantSeat(playback, tv.accountId, dateId);
  await grantSeat(playback, tv.accountId, dateId);
  const lapsing = ticketOf(await openCall(playback, tv, dateId));
  const kept = ticketOf(await openCall(playback, phone, dateId));
  playback.clock.advance((PLAYBACK_LEASE_SECONDS - 10) * 1_000);
  expect((await renewCall(playback, phone, kept.sessionId)).statusCode).toBe(200);
  playback.clock.advance(10_000);
  return { tv, lapsing, kept };
}

async function stateOf(accountId: string, sessionId: string): Promise<string | undefined> {
  return (await sessionsOf(playback, accountId)).find(({ id }) => id === sessionId)?.state;
}

describe('the lease-expiry pass', () => {
  it(
    'expires the lapsed lease and leaves the renewed one, a batch at a time',
    async () => {
      const { tv, lapsing, kept } = await lapsedAndRenewed();

      const passes: number[] = [];
      for (let swept = await playback.sweep(1); swept > 0; swept = await playback.sweep(1)) {
        passes.push(swept);
      }

      expect(passes.length).toBeGreaterThan(0);
      expect(passes.every((swept) => swept === 1)).toBe(true);
      expect(await stateOf(tv.accountId, lapsing.sessionId)).toBe(PlaybackSessionState.EXPIRED);
      expect(await stateOf(tv.accountId, kept.sessionId)).toBe(PlaybackSessionState.ACTIVE);
    },
    CASE_MS,
  );

  it(
    'skips a lapsed lease another transaction holds, and expires it at the next pass',
    async () => {
      const { tv, lapsing } = await lapsedAndRenewed();
      const holder = playback.dataSource.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      try {
        await holder.query('SELECT 1 FROM playback_session WHERE id = $1 FOR UPDATE', [
          lapsing.sessionId,
        ]);
        await playback.sweep();
        expect(await stateOf(tv.accountId, lapsing.sessionId)).toBe(PlaybackSessionState.ACTIVE);
      } finally {
        await holder.commitTransaction();
        await holder.release();
      }

      expect(await playback.sweep()).toBe(1);
      expect(await stateOf(tv.accountId, lapsing.sessionId)).toBe(PlaybackSessionState.EXPIRED);
    },
    CASE_MS,
  );
});
