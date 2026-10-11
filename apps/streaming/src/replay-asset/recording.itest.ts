import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';

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
  RECORDING_ATTEMPTS_MAX,
  RECORDING_CALL_TIMEOUT_MS,
  RECORDING_RETRY_DELAYS_MS,
} from './recording-calls.js';
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
import { RecordingNotFound, type RecordingRef } from '../media/media-ports.js';
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
      const transaction = vi.spyOn(desk.dataSource, 'transaction');
      await desk.passes.requestRecordings();
      expect(transaction).not.toHaveBeenCalled();
      transaction.mockRestore();
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

function silenced(level: 'error' | 'warn'): MockInstance<(message: unknown) => void> {
  return vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
}

function messagesOf(logged: MockInstance<(message: unknown) => void>): string[] {
  return logged.mock.calls.map(([message]) => String(message));
}

async function isGone(ref: RecordingRef | undefined): Promise<boolean> {
  if (ref === undefined) throw new Error('no recording was started');
  try {
    await desk.fake.status(ref);
    return false;
  } catch (error) {
    return error instanceof RecordingNotFound;
  }
}

describe('a recording started that the asset cannot keep', () => {
  it(
    'is deleted at the provider when its outcome is not written, the asset neither failed nor lost',
    async () => {
      const date = await seedDate(desk);
      await desk.passes.requestRecordings();
      await desk.dataSource.query('UPDATE replay_asset SET call_attempts = $2 WHERE date_id = $1', [
        date.dateId,
        RECORDING_ATTEMPTS_MAX - 1,
      ]);
      const realStart = desk.fake.start.bind(desk.fake);
      const started: RecordingRef[] = [];
      const start = vi.spyOn(desk.fake, 'start').mockImplementation(async (streamPath) => {
        const ref = await realStart(streamPath);
        if (streamPath === date.streamPath) started.push(ref);
        return ref;
      });
      const errors = silenced('error');
      await desk.dataSource.query(
        `ALTER TABLE replay_asset ADD CONSTRAINT refuse_ref
           CHECK (date_id <> '${date.dateId}' OR recording_ref IS NULL) NOT VALID`,
      );
      try {
        await desk.calls.pass();
      } finally {
        await desk.dataSource.query('ALTER TABLE replay_asset DROP CONSTRAINT refuse_ref');
      }

      expect(await assetOf(desk, date.dateId)).toMatchObject({
        state: ReplayAssetState.RECORDING,
        recording_ref: null,
        call_attempts: RECORDING_ATTEMPTS_MAX,
        call_dead_at: null,
      });
      expect(started).toHaveLength(1);
      expect(await isGone(started[0])).toBe(true);
      const messages = messagesOf(errors).filter((message) => message.includes(date.dateId));
      expect(messages).toHaveLength(2);
      expect(messages.join()).not.toContain('rec_');

      desk.clock.advance(RECORDING_RETRY_DELAYS_MS.at(-1) ?? 0);
      await desk.calls.pass();
      expect(started).toHaveLength(2);
      expect(await assetOf(desk, date.dateId)).toMatchObject({
        state: ReplayAssetState.RECORDING,
        recording_ref: started[1],
        call_attempts: 0,
      });
      start.mockRestore();
      errors.mockRestore();
    },
    CASE_MS,
  );

  it(
    'is deleted after the commit when another start won meanwhile, the delete retried',
    async () => {
      const date = await seedDate(desk);
      await desk.passes.requestRecordings();
      const realStart = desk.fake.start.bind(desk.fake);
      const realDelete = desk.fake.delete.bind(desk.fake);
      let winner: RecordingRef | undefined;
      let orphan: RecordingRef | undefined;
      const start = vi.spyOn(desk.fake, 'start').mockImplementation(async (streamPath) => {
        if (streamPath !== date.streamPath) return realStart(streamPath);
        winner = await realStart(streamPath);
        await desk.dataSource.query(
          'UPDATE replay_asset SET recording_ref = $2 WHERE date_id = $1',
          [date.dateId, winner],
        );
        orphan = await realStart(streamPath);
        return orphan;
      });
      let refused = false;
      const remove = vi.spyOn(desk.fake, 'delete').mockImplementation(async (ref) => {
        if (ref === orphan && !refused) {
          refused = true;
          throw new Error('provider down');
        }
        await realDelete(ref);
      });
      const errors = silenced('error');
      const warnings = silenced('warn');

      await desk.calls.pass();

      expect((await assetOf(desk, date.dateId))?.recording_ref).toBe(winner);
      expect(remove.mock.calls.filter(([ref]) => ref === orphan)).toHaveLength(2);
      expect(await isGone(orphan)).toBe(true);
      expect(await isGone(winner)).toBe(false);
      expect(messagesOf(warnings).some((message) => message.includes(date.dateId))).toBe(true);
      expect(messagesOf(errors).join()).not.toContain('rec_');
      start.mockRestore();
      remove.mockRestore();
      errors.mockRestore();
      warnings.mockRestore();
    },
    CASE_MS,
  );

  it(
    'counts a start answering after its timeout as a failed attempt, and deletes what it started',
    async () => {
      const date = await seedDate(desk);
      await desk.passes.requestRecordings();
      const realStart = desk.fake.start.bind(desk.fake);
      let late: Promise<RecordingRef> | undefined;
      const start = vi.spyOn(desk.fake, 'start').mockImplementation((streamPath) => {
        if (streamPath !== date.streamPath) return realStart(streamPath);
        late = new Promise<void>((resolve) => {
          setTimeout(resolve, RECORDING_CALL_TIMEOUT_MS + 500);
        }).then(() => realStart(streamPath));
        return late;
      });
      const errors = silenced('error');
      const warnings = silenced('warn');

      await desk.calls.pass();

      expect(await assetOf(desk, date.dateId)).toMatchObject({
        state: ReplayAssetState.RECORDING,
        recording_ref: null,
        call_attempts: 1,
      });
      const failed = messagesOf(warnings).filter((message) => message.includes(date.dateId));
      expect(failed).toEqual([
        expect.stringContaining('start call failed, attempt 1: RecordingCallTimedOut'),
      ]);

      const lateRef = await late;
      await vi.waitFor(async () => {
        expect(await isGone(lateRef)).toBe(true);
      });
      start.mockRestore();
      errors.mockRestore();
      warnings.mockRestore();
    },
    CASE_MS,
  );
});
