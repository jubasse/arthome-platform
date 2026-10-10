import { CommandBus } from '@nestjs/cqrs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DateOutcome,
  ReplayAssetState,
  ReplayPolicy,
  RunState,
  endsAt,
  plusMinutes,
  RUN_AUTO_END_MINUTES,
  toEpochMs,
} from '@arthome/core';

import {
  CASE_MS,
  STARTUP_MS,
  assetCount,
  assetOf,
  seedDate,
  setRunState,
  startReplayDesk,
  stopReplayDesk,
  type ReplayDesk,
} from '../itest/replay-desk.js';
import { EndRunsByThemselves } from '../run/run-passes.js';

/**
 * Requirements 1 and 2: a run on air whose date has a replay mode is recorded from its start; a date
 * without one is neither recorded nor given a row; the recording closes with the run.
 */

let desk: ReplayDesk;

beforeAll(async () => {
  desk = await startReplayDesk('streaming_recording_itest');
}, STARTUP_MS);

afterAll(async () => {
  await stopReplayDesk(desk);
});

describe('the recording of a run on air', () => {
  it(
    'starts on the provider for a date with a replay mode, from the run start',
    async () => {
      const date = await seedDate(desk);
      expect(await desk.passes.requestRecordings()).toBeGreaterThanOrEqual(1);
      const requested = await assetOf(desk, date.dateId);
      expect(requested).toMatchObject({ state: ReplayAssetState.RECORDING, recording_ref: null });

      const start = vi.spyOn(desk.fake, 'start');
      await desk.calls.pass();
      expect(start).toHaveBeenCalledWith(date.streamPath);
      start.mockRestore();

      const started = await assetOf(desk, date.dateId);
      expect(started?.recording_ref).toMatch(/^rec_/);
      expect(started).toMatchObject({ call_attempts: 0, call_next_attempt_at: null });
      const [recorded] = await desk.dataSource.query<{ recorded_from: Date }[]>(
        'SELECT recorded_from FROM replay_asset WHERE date_id = $1',
        [date.dateId],
      );
      expect(recorded?.recorded_from.toISOString()).toBe(date.startsAt);
    },
    CASE_MS,
  );

  it(
    'leaves a date with no replay mode without a row and without a call',
    async () => {
      const date = await seedDate(desk, { policy: ReplayPolicy.NONE });
      const start = vi.spyOn(desk.fake, 'start');
      await desk.passes.requestRecordings();
      await desk.calls.pass();
      expect(await assetCount(desk, date.dateId)).toBe(0);
      expect(start).not.toHaveBeenCalled();
      start.mockRestore();
    },
    CASE_MS,
  );

  it(
    'looks again at a date whose facts are not projected yet',
    async () => {
      const date = await seedDate(desk);
      await desk.dataSource.query('DELETE FROM entitlement_date WHERE date_id = $1', [date.dateId]);
      await desk.passes.requestRecordings();
      expect(await assetCount(desk, date.dateId)).toBe(0);

      await desk.dataSource.query(
        `INSERT INTO entitlement_date (date_id, starts_at, runtime_min, replay_policy,
                                       replay_window_hours, applied_at)
         VALUES ($1, $2, 90, $3, 24, $2)`,
        [date.dateId, date.startsAt, ReplayPolicy.UNIT],
      );
      await desk.passes.requestRecordings();
      expect(await assetCount(desk, date.dateId)).toBe(1);
    },
    CASE_MS,
  );

  it(
    'does not record a date whose replay is already withdrawn',
    async () => {
      const date = await seedDate(desk, { outcome: DateOutcome.CANCELLED });
      await desk.passes.requestRecordings();
      expect(await assetCount(desk, date.dateId)).toBe(0);
    },
    CASE_MS,
  );

  it(
    'keeps one asset through an interruption and the run back on air',
    async () => {
      const date = await seedDate(desk);
      await desk.passes.requestRecordings();
      await desk.calls.pass();
      const ref = (await assetOf(desk, date.dateId))?.recording_ref;

      await setRunState(desk, date.dateId, RunState.INTERRUPTED);
      await desk.passes.requestRecordings();
      await desk.passes.closeRecordings();
      expect((await assetOf(desk, date.dateId))?.state).toBe(ReplayAssetState.RECORDING);

      await setRunState(desk, date.dateId, RunState.ON_AIR);
      await desk.passes.requestRecordings();
      await desk.calls.pass();
      expect(await assetCount(desk, date.dateId)).toBe(1);
      expect((await assetOf(desk, date.dateId))?.recording_ref).toBe(ref);
    },
    CASE_MS,
  );

  it(
    'is closed by the run ending by itself, at the instant of its end',
    async () => {
      const date = await seedDate(desk);
      await desk.passes.requestRecordings();
      await desk.calls.pass();
      const scheduledEnd = endsAt({
        startsAt: date.startsAt,
        runtimeMin: date.runtimeMin,
        roomOpensBeforeMin: 0,
        replayPolicy: ReplayPolicy.UNIT,
        replayWindowHours: 48,
      });
      desk.clock.advance(
        toEpochMs(plusMinutes(scheduledEnd, RUN_AUTO_END_MINUTES)) - desk.clock.nowMs(),
      );
      await desk.passes.closeRecordings();
      expect((await assetOf(desk, date.dateId))?.state).toBe(ReplayAssetState.RECORDING);

      await desk.app.get(CommandBus).execute(new EndRunsByThemselves());
      await desk.passes.closeRecordings();
      expect(await assetOf(desk, date.dateId)).toMatchObject({
        state: ReplayAssetState.PROCESSING,
        recorded_until: new Date(scheduledEnd),
      });
    },
    CASE_MS,
  );
});
