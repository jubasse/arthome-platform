import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DateOutcome, ReplayAssetState, plusMinutes } from '@arthome/core';

import { RECORDING_ATTEMPTS_MAX, RECORDING_RETRY_DELAYS_MS } from './recording-calls.js';
import {
  CASE_MS,
  STARTUP_MS,
  assetCount,
  assetOf,
  endRun,
  outboxTypesOf,
  recordedAndReady,
  recordingStarted,
  refOf,
  seedDate,
  setOutcome,
  startReplayDesk,
  stopReplayDesk,
  type ReplayDesk,
} from '../itest/replay-desk.js';
import { RecordingNotFound } from '../media/media-ports.js';

/**
 * Requirements 3 and 5 to 8: a replay is deleted at its closing or as soon as its date can have none,
 * `expired.v1` for the announced ones only, every provider call retried on its backoff and bounded.
 */

let desk: ReplayDesk;

beforeAll(async () => {
  desk = await startReplayDesk('streaming_asset_deletion_itest');
}, STARTUP_MS);

afterAll(async () => {
  await stopReplayDesk(desk);
});

async function readyAsset(windowHours = 48) {
  const date = await seedDate(desk, { windowHours });
  const endedAt = await recordedAndReady(desk, date, 60, 3_000);
  const ref = await refOf(desk, date.dateId);
  return { date, endedAt, ref };
}

describe('the deletion at the closing', () => {
  it(
    'waits for the closing, then deletes through the provider and says so once',
    async () => {
      const { date, ref } = await readyAsset(48);
      const closing = plusMinutes(date.startsAt, 60 + 48 * 60);

      desk.clock.advance(Date.parse(closing) - 1 - desk.clock.nowMs());
      expect(await desk.passes.expire()).toBe(0);
      expect((await assetOf(desk, date.dateId))?.state).toBe(ReplayAssetState.READY);

      desk.clock.advance(1);
      expect(await desk.passes.expire()).toBe(1);
      expect((await assetOf(desk, date.dateId))?.state).toBe(ReplayAssetState.DELETING);
      expect(await outboxTypesOf(desk, date.dateId)).toEqual([
        'streaming.replay.asset_ready.v1',
        'streaming.replay.expired.v1',
      ]);

      await desk.calls.pass();
      expect(await assetOf(desk, date.dateId)).toMatchObject({
        state: ReplayAssetState.DELETED,
        recording_ref: null,
        deleted_at: new Date(desk.clock.now()),
      });
      await expect(desk.fake.status(ref)).rejects.toBeInstanceOf(RecordingNotFound);
    },
    CASE_MS,
  );

  it(
    'is final: no later pass moves the deleted asset or makes a second row',
    async () => {
      const { date } = await readyAsset(1);
      desk.clock.advance(2 * 60 * 60_000);
      await desk.passes.expire();
      await desk.calls.pass();
      expect((await assetOf(desk, date.dateId))?.state).toBe(ReplayAssetState.DELETED);
      const events = await outboxTypesOf(desk, date.dateId);

      await setOutcome(desk, date.dateId, DateOutcome.CANCELLED);
      desk.clock.advance(24 * 60 * 60_000);
      await desk.passes.requestRecordings();
      await desk.passes.closeRecordings();
      await desk.passes.withdraw();
      await desk.passes.expire();
      await desk.calls.pass();

      expect((await assetOf(desk, date.dateId))?.state).toBe(ReplayAssetState.DELETED);
      expect(await assetCount(desk, date.dateId)).toBe(1);
      expect(await outboxTypesOf(desk, date.dateId)).toEqual(events);
    },
    CASE_MS,
  );
});

describe('the deletion at a withdrawal', () => {
  it(
    'stops and deletes a recording still under way when the date is interrupted, announcing nothing',
    async () => {
      const date = await seedDate(desk);
      await recordingStarted(desk, date);
      const ref = await refOf(desk, date.dateId);
      await setOutcome(desk, date.dateId, DateOutcome.INTERRUPTED);

      expect(await desk.passes.withdraw()).toBe(1);
      expect((await assetOf(desk, date.dateId))?.state).toBe(ReplayAssetState.DELETING);

      const stop = vi.spyOn(desk.fake, 'stop');
      const remove = vi.spyOn(desk.fake, 'delete');
      await desk.calls.pass();
      expect(stop).toHaveBeenCalledOnce();
      expect(remove).not.toHaveBeenCalled();
      await desk.calls.pass();
      expect(remove).toHaveBeenCalledOnce();
      stop.mockRestore();
      remove.mockRestore();

      expect((await assetOf(desk, date.dateId))?.state).toBe(ReplayAssetState.DELETED);
      await expect(desk.fake.status(ref)).rejects.toBeInstanceOf(RecordingNotFound);
      expect(await outboxTypesOf(desk, date.dateId)).toEqual([]);
    },
    CASE_MS,
  );

  it(
    'announces the expiry of a ready replay whose date is cancelled, and deletes it',
    async () => {
      const { date } = await readyAsset();
      await setOutcome(desk, date.dateId, DateOutcome.CANCELLED);
      await desk.passes.withdraw();
      await desk.calls.pass();

      expect((await assetOf(desk, date.dateId))?.state).toBe(ReplayAssetState.DELETED);
      expect(await outboxTypesOf(desk, date.dateId)).toEqual([
        'streaming.replay.asset_ready.v1',
        'streaming.replay.expired.v1',
      ]);
    },
    CASE_MS,
  );

  it(
    'withdraws nothing for a postponed date',
    async () => {
      const { date } = await readyAsset();
      await setOutcome(desk, date.dateId, DateOutcome.POSTPONED);
      expect(await desk.passes.withdraw()).toBe(0);
      expect((await assetOf(desk, date.dateId))?.state).toBe(ReplayAssetState.READY);
    },
    CASE_MS,
  );

  it(
    'deletes with no provider call an asset withdrawn before the provider ever started it',
    async () => {
      const date = await seedDate(desk);
      await desk.passes.requestRecordings();
      await setOutcome(desk, date.dateId, DateOutcome.CANCELLED);
      await desk.passes.withdraw();

      const remove = vi.spyOn(desk.fake, 'delete');
      await desk.calls.pass();
      expect(remove).not.toHaveBeenCalled();
      remove.mockRestore();
      expect((await assetOf(desk, date.dateId))?.state).toBe(ReplayAssetState.DELETED);
    },
    CASE_MS,
  );
});

describe('the provider calls', () => {
  it(
    'retries a delete failing twice on its backoff, then succeeds',
    async () => {
      const { date } = await readyAsset(1);
      desk.clock.advance(2 * 60 * 60_000);
      await desk.passes.expire();

      const remove = vi
        .spyOn(desk.fake, 'delete')
        .mockRejectedValueOnce(new Error('provider down'))
        .mockRejectedValueOnce(new Error('provider down'));

      await desk.calls.pass();
      const first = await assetOf(desk, date.dateId);
      expect(first).toMatchObject({ state: ReplayAssetState.DELETING, call_attempts: 1 });
      const firstDelay = (first?.call_next_attempt_at?.getTime() ?? 0) - desk.clock.nowMs();
      expect(firstDelay).toBeGreaterThanOrEqual(RECORDING_RETRY_DELAYS_MS[0] ?? 0);
      expect(firstDelay).toBeLessThanOrEqual((RECORDING_RETRY_DELAYS_MS[0] ?? 0) * 1.2);

      expect(await desk.calls.pass()).toBe(0);
      expect(remove).toHaveBeenCalledTimes(1);

      desk.clock.advance(firstDelay);
      await desk.calls.pass();
      expect(await assetOf(desk, date.dateId)).toMatchObject({ call_attempts: 2 });

      desk.clock.advance((RECORDING_RETRY_DELAYS_MS[1] ?? 0) * 1.2);
      await desk.calls.pass();
      expect(remove).toHaveBeenCalledTimes(3);
      expect(await assetOf(desk, date.dateId)).toMatchObject({
        state: ReplayAssetState.DELETED,
        call_attempts: 0,
      });
      remove.mockRestore();
    },
    CASE_MS,
  );

  it(
    'gives up a call always failing after its bound: failed, with its name, logged at error level',
    async () => {
      const { date } = await readyAsset(1);
      desk.clock.advance(2 * 60 * 60_000);
      await desk.passes.expire();
      const remove = vi.spyOn(desk.fake, 'delete').mockRejectedValue(new Error('provider down'));
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      for (let attempt = 1; attempt <= RECORDING_ATTEMPTS_MAX; attempt += 1) {
        expect((await assetOf(desk, date.dateId))?.state).toBe(ReplayAssetState.DELETING);
        await desk.calls.pass();
        desk.clock.advance(6 * 60_000);
      }

      expect(remove).toHaveBeenCalledTimes(RECORDING_ATTEMPTS_MAX);
      expect(await assetOf(desk, date.dateId)).toMatchObject({
        state: ReplayAssetState.FAILED,
        failed_call: 'delete',
        call_attempts: RECORDING_ATTEMPTS_MAX,
        call_next_attempt_at: null,
      });
      expect((await assetOf(desk, date.dateId))?.call_dead_at).not.toBeNull();
      const messages = logged.mock.calls.map(([message]) => String(message));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(date.dateId);
      expect(messages[0]).not.toContain('rec_');

      expect(await desk.calls.pass()).toBe(0);
      expect(remove).toHaveBeenCalledTimes(RECORDING_ATTEMPTS_MAX);
      remove.mockRestore();
      logged.mockRestore();
    },
    CASE_MS,
  );

  it(
    'gives up at once a recording the provider no longer knows',
    async () => {
      const date = await seedDate(desk);
      await recordingStarted(desk, date);
      await endRun(desk, date, 30);
      await desk.passes.closeRecordings();
      await desk.calls.pass();
      await desk.fake.delete(await refOf(desk, date.dateId));
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await desk.calls.pass();

      expect(await assetOf(desk, date.dateId)).toMatchObject({
        state: ReplayAssetState.FAILED,
        failed_call: 'status',
      });
      expect(logged).toHaveBeenCalledOnce();
      logged.mockRestore();
    },
    CASE_MS,
  );
});
