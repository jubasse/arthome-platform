import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DomainErrorCode,
  HOLD_SCREEN_AUTO_AFTER_SECONDS_DEFAULT,
  IncidentCause,
  IncidentKind,
  Locale,
  RunState,
} from '@arthome/core';

import { SweepRunPresence } from './run-passes.js';
import {
  CASE_MS,
  STARTUP_MS,
  feedOn,
  preparedRun,
  startRunDesk,
  stopRunDesk,
  studioCall,
  type PreparedRun,
  type RunDesk,
} from '../itest/run-desk.js';

/**
 * What runs at once on one run: a studio command against an automatic incident, two incidents,
 * the feed's return against the pass, two sweepers. Each ends consistent at one version, with at
 * most one open incident (HANDOVER §0's lock order: run, incident, key).
 */

const ROUNDS = 5;

let desk: RunDesk;

beforeAll(async () => {
  desk = await startRunDesk('streaming_run_races_itest');
}, STARTUP_MS);

afterAll(async () => {
  await stopRunDesk(desk);
});

async function checked(): Promise<PreparedRun> {
  const run = await preparedRun(desk);
  await feedOn(desk, run);
  await studioCall(desk, 'POST', `/v1/dates/${run.dateId}/run/technical-check`);
  return run;
}

function goOnAir(run: PreparedRun, expectedVersion: number) {
  return studioCall(desk, 'POST', `/v1/dates/${run.dateId}/run/go-on-air`, {
    body: { expectedVersion },
  });
}

function raise(run: PreparedRun) {
  return studioCall(desk, 'POST', `/v1/dates/${run.dateId}/incidents`, {
    body: {
      incidentId: randomUUID(),
      kind: IncidentKind.HOLD_SCREEN,
      cause: IncidentCause.MANUAL,
      message: { contentLanguage: Locale.FR, text: 'Un instant.' },
    },
  });
}

async function stateOf(run: PreparedRun) {
  const [row] = await desk.dataSource.query<
    { state: RunState; version: number; open: number; incidents: number }[]
  >(
    `SELECT run.state, run.version,
            (SELECT count(*)::int FROM incident WHERE run_id = run.id AND resolved_at IS NULL) AS open,
            (SELECT count(*)::int FROM incident WHERE run_id = run.id) AS incidents
       FROM run WHERE run.id = $1`,
    [run.runId],
  );
  return row;
}

function sweep(): Promise<number> {
  return desk.commands.execute(new SweepRunPresence());
}

describe('the run under concurrent writes', () => {
  it(
    'goOnAir against the automatic incident: either order, one consistent outcome',
    async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const run = await checked();
        const [onAir] = await Promise.all([goOnAir(run, 2), desk.fake.failWorker(run.streamPath)]);
        const after = await stateOf(run);
        if (onAir.statusCode === 200) {
          expect(after).toEqual({ state: RunState.INTERRUPTED, version: 4, open: 1, incidents: 1 });
        } else {
          expect(onAir.statusCode).toBe(409);
          expect(onAir.json()).toMatchObject({ error: { code: DomainErrorCode.STATE_CONFLICT } });
          expect(after).toEqual({ state: RunState.IDLE, version: 3, open: 1, incidents: 1 });
        }
      }
    },
    CASE_MS,
  );

  it(
    'two raiseIncident at once leave one open',
    async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const run = await preparedRun(desk);
        const answers = await Promise.all([raise(run), raise(run)]);
        expect(answers.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
        expect(await stateOf(run)).toMatchObject({ version: 2, open: 1, incidents: 1 });
      }
    },
    CASE_MS,
  );

  it(
    "the feed's return against the pass raising the hold screen: the run on air, nothing open",
    async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const run = await checked();
        await goOnAir(run, 2);
        await desk.fake.drop(run.streamPath);
        desk.clock.advance(HOLD_SCREEN_AUTO_AFTER_SECONDS_DEFAULT * 1000);

        await Promise.all([sweep(), desk.fake.resume(run.streamPath)]);

        const after = await stateOf(run);
        expect(after).toMatchObject({ state: RunState.ON_AIR, open: 0 });
        // Return first: nothing raised. Pass first: raised, then lifted by the return.
        expect([
          { version: 3, incidents: 0 },
          { version: 5, incidents: 1 },
        ]).toContainEqual({ version: after?.version, incidents: after?.incidents });
      }
    },
    CASE_MS,
  );

  it(
    'two sweepers on the same runs handle each run once',
    async () => {
      const runs: PreparedRun[] = [];
      for (let index = 0; index < 8; index += 1) {
        const run = await checked();
        await goOnAir(run, 2);
        await desk.fake.drop(run.streamPath);
        runs.push(run);
      }
      desk.clock.advance(HOLD_SCREEN_AUTO_AFTER_SECONDS_DEFAULT * 1000);

      const settled = await Promise.all([sweep(), sweep()]);

      expect(settled[0] + settled[1]).toBe(runs.length);
      for (const run of runs) {
        expect(await stateOf(run)).toEqual({
          state: RunState.INTERRUPTED,
          version: 4,
          open: 1,
          incidents: 1,
        });
      }
    },
    CASE_MS,
  );
});
