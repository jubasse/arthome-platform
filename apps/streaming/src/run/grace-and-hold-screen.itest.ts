import { randomUUID } from 'node:crypto';

import { RunStateChangedSchema } from '@arthome-platform/events';
import { fromBinary } from '@bufbuild/protobuf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  HOLD_SCREEN_AUTO_AFTER_SECONDS_DEFAULT,
  IncidentCause,
  IncidentKind,
  IncidentTrigger,
  Locale,
  PUBLISHER_GRACE_SECONDS,
  RunState,
} from '@arthome/core';

import { SweepRunPresence } from './run-passes.js';
import {
  CASE_MS,
  STARTUP_MS,
  feedOn,
  outboxOf,
  preparedRun,
  startRunDesk,
  stopRunDesk,
  studioCall,
  versionOf,
  type PreparedRun,
  type RunDesk,
} from '../itest/run-desk.js';

/**
 * A venue's feed lost and back, driven through the fake on the suite's clock: the grace absorbs a
 * glitch, "publisher gone" comes after it, the automatic hold screen at its delay and lifts itself
 * when the feed returns (D-124), and a final worker failure raises its own incident.
 */

let desk: RunDesk;

beforeAll(async () => {
  desk = await startRunDesk('streaming_grace_hold_screen_itest');
}, STARTUP_MS);

afterAll(async () => {
  await stopRunDesk(desk);
});

async function onAir(): Promise<PreparedRun> {
  const run = await preparedRun(desk);
  await feedOn(desk, run);
  await studioCall(desk, 'POST', `/v1/dates/${run.dateId}/run/technical-check`);
  const response = await studioCall(desk, 'POST', `/v1/dates/${run.dateId}/run/go-on-air`, {
    body: { expectedVersion: 2 },
  });
  if (response.statusCode !== 200) throw new Error(`not on air: ${response.body}`);
  return run;
}

function sweep(): Promise<number> {
  return desk.commands.execute(new SweepRunPresence());
}

async function rowOf(run: PreparedRun) {
  const [row] = await desk.dataSource.query<
    { state: RunState; after_grace_period: boolean; version: number }[]
  >('SELECT state, after_grace_period, version FROM run WHERE id = $1', [run.runId]);
  return row;
}

async function openIncidentOf(run: PreparedRun) {
  const [incident] = await desk.dataSource.query<
    { kind: string; cause: string; trigger: string; raised_by: string | null }[]
  >(
    'SELECT kind, cause, trigger, raised_by FROM incident WHERE run_id = $1 AND resolved_at IS NULL',
    [run.runId],
  );
  return incident ?? null;
}

async function typesSince(run: PreparedRun, count: number): Promise<string[]> {
  return (await outboxOf(desk, run.dateId)).slice(count).map(({ type }) => type);
}

describe('the grace', () => {
  it(
    'absorbs a two-second drop: no incident, no event, the version unmoved',
    async () => {
      const run = await onAir();
      const written = (await outboxOf(desk, run.dateId)).length;
      await desk.fake.drop(run.streamPath);
      desk.clock.advance(2_000);
      await sweep();
      await desk.fake.resume(run.streamPath);
      desk.clock.advance(10_000);
      await sweep();

      expect(await rowOf(run)).toEqual({
        state: RunState.ON_AIR,
        after_grace_period: false,
        version: 3,
      });
      expect(await typesSince(run, written)).toEqual([]);
    },
    CASE_MS,
  );

  it(
    'past it, writes "publisher gone" with the version unmoved; a publisher back clears it',
    async () => {
      const run = await onAir();
      const written = (await outboxOf(desk, run.dateId)).length;
      await desk.fake.drop(run.streamPath);
      desk.clock.advance(PUBLISHER_GRACE_SECONDS * 1000);
      expect(await sweep()).toBe(1);
      expect(await rowOf(run)).toEqual({
        state: RunState.ON_AIR,
        after_grace_period: true,
        version: 3,
      });
      const console = await studioCall(desk, 'GET', `/v1/dates/${run.dateId}/run`);
      expect(console.json()).toMatchObject({ data: { afterGracePeriod: true, version: 3 } });

      await desk.fake.resume(run.streamPath);
      expect(await rowOf(run)).toEqual({
        state: RunState.ON_AIR,
        after_grace_period: false,
        version: 3,
      });
      const rows = (await outboxOf(desk, run.dateId)).slice(written);
      expect(rows.map(({ type }) => type)).toEqual([
        'streaming.run.state_changed.v1',
        'streaming.run.state_changed.v1',
      ]);
      expect(
        rows.map(({ payload }) => fromBinary(RunStateChangedSchema, payload).afterGracePeriod),
      ).toEqual([true, false]);
    },
    CASE_MS,
  );
});

describe('the automatic hold screen (D-124)', () => {
  it(
    'comes at its delay, interrupting the run, and lifts itself when the feed returns',
    async () => {
      const run = await onAir();
      const written = (await outboxOf(desk, run.dateId)).length;
      await desk.fake.drop(run.streamPath);
      desk.clock.advance(HOLD_SCREEN_AUTO_AFTER_SECONDS_DEFAULT * 1000 - 1);
      await sweep();
      expect(await openIncidentOf(run)).toBeNull();

      desk.clock.advance(1);
      await sweep();
      expect(await openIncidentOf(run)).toEqual({
        kind: IncidentKind.HOLD_SCREEN,
        cause: IncidentCause.VENUE_FEED_LOST,
        trigger: IncidentTrigger.AUTO,
        raised_by: null,
      });
      expect(await rowOf(run)).toMatchObject({ state: RunState.INTERRUPTED, version: 4 });

      await desk.fake.resume(run.streamPath);
      expect(await openIncidentOf(run)).toBeNull();
      expect(await rowOf(run)).toEqual({
        state: RunState.ON_AIR,
        after_grace_period: false,
        version: 5,
      });
      expect(await typesSince(run, written)).toEqual([
        'streaming.run.state_changed.v1',
        'streaming.incident.raised.v1',
        'streaming.run.state_changed.v1',
        'streaming.incident.resolved.v1',
        'streaming.run.state_changed.v1',
      ]);
    },
    CASE_MS,
  );

  it(
    'leaves an incident raised by hand when the feed returns',
    async () => {
      const run = await onAir();
      await studioCall(desk, 'POST', `/v1/dates/${run.dateId}/incidents`, {
        body: {
          incidentId: randomUUID(),
          kind: IncidentKind.HOLD_SCREEN,
          cause: IncidentCause.VENUE_FEED_LOST,
          message: { contentLanguage: Locale.FR, text: 'Coupure à la salle.' },
        },
      });
      await desk.fake.drop(run.streamPath);
      desk.clock.advance(HOLD_SCREEN_AUTO_AFTER_SECONDS_DEFAULT * 1000);
      await sweep();
      await desk.fake.resume(run.streamPath);

      expect(await openIncidentOf(run)).toMatchObject({ trigger: IncidentTrigger.MANUAL });
      expect((await rowOf(run))?.state).toBe(RunState.INTERRUPTED);
    },
    CASE_MS,
  );
});

describe('a worker that fails for good', () => {
  it(
    'raises an automatic compatibility_worker_failed incident, and only one',
    async () => {
      const run = await onAir();
      const before = await versionOf(desk, run.dateId);
      await desk.fake.failWorker(run.streamPath);

      expect(await openIncidentOf(run)).toEqual({
        kind: IncidentKind.HOLD_SCREEN,
        cause: IncidentCause.COMPATIBILITY_WORKER_FAILED,
        trigger: IncidentTrigger.AUTO,
        raised_by: null,
      });
      expect(await rowOf(run)).toMatchObject({
        state: RunState.INTERRUPTED,
        version: before + 1,
      });

      await desk.fake.failWorker(run.streamPath);
      const [count] = await desk.dataSource.query<{ incidents: number }[]>(
        'SELECT count(*)::int AS incidents FROM incident WHERE run_id = $1',
        [run.runId],
      );
      expect(count?.incidents).toBe(1);
    },
    CASE_MS,
  );
});
