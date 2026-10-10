import { RunEndedSchema, Surface as WireSurface } from '@arthome-platform/events';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  HOLD_SCREEN_AUTO_AFTER_SECONDS_DEFAULT,
  RUN_AUTO_END_MINUTES,
  RunState,
  endsAt,
  plusMinutes,
  toEpochMs,
} from '@arthome/core';

import { EndRunsByThemselves, SweepRunPresence } from './run-passes.js';
import {
  CASE_MS,
  STARTUP_MS,
  feedOn,
  outboxOf,
  preparedRun,
  startRunDesk,
  stopRunDesk,
  studioCall,
  timingOf,
  type PreparedRun,
  type RunDesk,
} from '../itest/run-desk.js';

/**
 * D-123: a run left on air ends by itself fifteen minutes after the later of its scheduled end and
 * its last publisher's loss, its end that loss, never while a publisher is online.
 */

let desk: RunDesk;

beforeAll(async () => {
  desk = await startRunDesk('streaming_auto_end_itest');
}, STARTUP_MS);

afterAll(async () => {
  await stopRunDesk(desk);
});

const MINUTE_MS = 60_000;

/** On air on a feed, its scheduled end 90 minutes after now. */
async function onAir(): Promise<{ run: PreparedRun; scheduledEnd: string }> {
  const run = await preparedRun(desk);
  await feedOn(desk, run);
  await studioCall(desk, 'POST', `/v1/dates/${run.dateId}/run/technical-check`);
  await studioCall(desk, 'POST', `/v1/dates/${run.dateId}/run/go-on-air`, {
    body: { expectedVersion: 2 },
  });
  return { run, scheduledEnd: endsAt(timingOf(desk.clock.now())) };
}

function endPass(): Promise<number> {
  return desk.commands.execute(new EndRunsByThemselves());
}

async function endOf(run: PreparedRun) {
  const [row] = await desk.dataSource.query<{ state: RunState; ended_at: Date | null }[]>(
    'SELECT state, ended_at FROM run WHERE id = $1',
    [run.runId],
  );
  return row;
}

function advanceTo(instant: string): void {
  desk.clock.advance(toEpochMs(instant) - desk.clock.nowMs());
}

describe('the end by itself', () => {
  it(
    'comes fifteen minutes after the scheduled end, ended at the last loss, by the system',
    async () => {
      const { run, scheduledEnd } = await onAir();
      desk.clock.advance(10 * MINUTE_MS);
      const lostAt = desk.clock.now();
      await desk.fake.drop(run.streamPath);

      advanceTo(plusMinutes(scheduledEnd, RUN_AUTO_END_MINUTES));
      desk.clock.advance(-1);
      await endPass();
      expect((await endOf(run))?.state).toBe(RunState.ON_AIR);

      desk.clock.advance(1);
      await endPass();
      expect(await endOf(run)).toEqual({ state: RunState.ENDED, ended_at: new Date(lostAt) });

      const ended = (await outboxOf(desk, run.dateId)).find(
        ({ type }) => type === 'streaming.run.ended.v1',
      );
      const payload = fromBinary(RunEndedSchema, ended?.payload ?? new Uint8Array());
      expect(payload.endedBy).toMatchObject({ accountId: '', surface: WireSurface.SYSTEM });
      expect(payload.endedAt && timestampDate(payload.endedAt).toISOString()).toBe(lostAt);
      expect(payload.durationSec).toBe(10 * 60);
      expect(payload.peakViewers).toBeUndefined();
    },
    CASE_MS,
  );

  it(
    'resolves, as the system, the hold screen the presence pass raised over the lost feed',
    async () => {
      const { run, scheduledEnd } = await onAir();
      await desk.fake.drop(run.streamPath);
      desk.clock.advance(HOLD_SCREEN_AUTO_AFTER_SECONDS_DEFAULT * 1000);
      await desk.commands.execute(new SweepRunPresence());
      expect((await endOf(run))?.state).toBe(RunState.INTERRUPTED);
      const written = (await outboxOf(desk, run.dateId)).length;

      advanceTo(plusMinutes(scheduledEnd, RUN_AUTO_END_MINUTES));
      await endPass();

      expect((await endOf(run))?.state).toBe(RunState.ENDED);
      const open = await desk.dataSource.query<{ id: string }[]>(
        'SELECT id FROM incident WHERE run_id = $1 AND resolved_at IS NULL',
        [run.runId],
      );
      expect(open).toEqual([]);
      const rows = (await outboxOf(desk, run.dateId)).slice(written);
      expect(rows.map(({ type }) => type)).toEqual([
        'streaming.incident.resolved.v1',
        'streaming.run.ended.v1',
        'streaming.run.state_changed.v1',
      ]);
    },
    CASE_MS,
  );

  it(
    'after an overrun, comes fifteen minutes after the last loss',
    async () => {
      const { run, scheduledEnd } = await onAir();
      advanceTo(plusMinutes(scheduledEnd, 30));
      const lostAt = desk.clock.now();
      await desk.fake.drop(run.streamPath);

      advanceTo(plusMinutes(lostAt, RUN_AUTO_END_MINUTES - 1));
      await endPass();
      expect((await endOf(run))?.state).toBe(RunState.ON_AIR);

      advanceTo(plusMinutes(lostAt, RUN_AUTO_END_MINUTES));
      await endPass();
      expect(await endOf(run)).toEqual({ state: RunState.ENDED, ended_at: new Date(lostAt) });
    },
    CASE_MS,
  );

  it(
    'never while a publisher is online, overrunning or not; an interrupted run ends too',
    async () => {
      const online = await onAir();
      const interrupted = await onAir();
      await desk.fake.failWorker(interrupted.run.streamPath);
      await desk.fake.drop(interrupted.run.streamPath);

      advanceTo(plusMinutes(online.scheduledEnd, 600));
      await endPass();

      expect((await endOf(online.run))?.state).toBe(RunState.ON_AIR);
      expect((await endOf(interrupted.run))?.state).toBe(RunState.ENDED);
    },
    CASE_MS,
  );

  it(
    'ends a run whose publisher was never online at its scheduled end',
    async () => {
      const run = await preparedRun(desk);
      await desk.dataSource.query(
        'UPDATE run SET state = $2, started_at = $3, version = 4 WHERE id = $1',
        [run.runId, RunState.ON_AIR, desk.clock.now()],
      );
      const scheduledEnd = endsAt(timingOf(desk.clock.now()));
      advanceTo(plusMinutes(scheduledEnd, RUN_AUTO_END_MINUTES));
      await endPass();
      expect(await endOf(run)).toEqual({ state: RunState.ENDED, ended_at: new Date(scheduledEnd) });
    },
    CASE_MS,
  );

  it(
    'never ends a run whose date has no timing projected',
    async () => {
      const { run } = await onAir();
      desk.dates.set(run.dateId, { timing: null, publicationState: null });
      await desk.fake.drop(run.streamPath);
      desk.clock.advance(100 * 60 * MINUTE_MS);
      await endPass();
      expect((await endOf(run))?.state).toBe(RunState.ON_AIR);
    },
    CASE_MS,
  );
});
