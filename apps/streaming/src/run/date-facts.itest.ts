import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DomainErrorCode,
  PublicationState,
  ReplayPolicy,
  RunState,
  plusMinutes,
  RUN_AUTO_END_MINUTES,
} from '@arthome/core';

import { EndRunsByThemselves } from './run-passes.js';
import { NO_PUBLICATION } from './run.aggregate.js';
import {
  CASE_MS,
  CHANNEL,
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
 * The run desk on PS2's own projection, `readDateFacts` over `entitlement_date`: the publication
 * `goOnAir` reads and the timing the end by itself reads. The other suites project through a map.
 */

let desk: RunDesk;

beforeAll(async () => {
  desk = await startRunDesk('streaming_run_date_facts_itest', { projectedByEntitlement: true });
}, STARTUP_MS);

afterAll(async () => {
  await stopRunDesk(desk);
});

async function project(run: PreparedRun, publicationState: PublicationState): Promise<void> {
  await desk.dataSource.query(
    `INSERT INTO entitlement_date (date_id, channel_id, starts_at, runtime_min, timing_occurred_at,
                                   replay_policy, replay_window_hours, replay_occurred_at,
                                   publication_state, publication_version, applied_at)
     VALUES ($1, $2, $3, 90, $3, $5, 0, $3, $4, 1, $3)
     ON CONFLICT (date_id) DO UPDATE SET publication_state = excluded.publication_state`,
    [run.dateId, CHANNEL, new Date(desk.clock.now()), publicationState, ReplayPolicy.NONE],
  );
}

async function checked(): Promise<PreparedRun> {
  const run = await preparedRun(desk);
  await feedOn(desk, run);
  await studioCall(desk, 'POST', `/v1/dates/${run.dateId}/run/technical-check`);
  return run;
}

function goOnAir(run: PreparedRun) {
  return studioCall(desk, 'POST', `/v1/dates/${run.dateId}/run/go-on-air`, {
    body: { expectedVersion: 2 },
  });
}

describe("goOnAir on PS2's projection", () => {
  it(
    'is refused from none while the date is not projected, then from its projected state',
    async () => {
      const run = await checked();
      const unprojected = await goOnAir(run);
      expect(unprojected.json()).toMatchObject({
        error: {
          code: DomainErrorCode.PUBLICATION_TRANSITION_FORBIDDEN,
          params: { from: NO_PUBLICATION, to: PublicationState.LIVE },
        },
      });

      await project(run, PublicationState.SCHEDULED);
      expect((await goOnAir(run)).json()).toMatchObject({
        error: { params: { from: PublicationState.SCHEDULED } },
      });
    },
    CASE_MS,
  );

  it(
    'goes on air on a technical publication, and the run ends by itself from its timing',
    async () => {
      const run = await checked();
      await project(run, PublicationState.TECHNICAL);
      const response = await goOnAir(run);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ data: { state: RunState.ON_AIR } });

      await desk.fake.drop(run.streamPath);
      const scheduledEnd = plusMinutes(desk.clock.now(), 90);
      desk.clock.advance(
        Date.parse(plusMinutes(scheduledEnd, RUN_AUTO_END_MINUTES)) - desk.clock.nowMs(),
      );
      await desk.commands.execute(new EndRunsByThemselves());
      const [row] = await desk.dataSource.query<{ state: RunState }[]>(
        'SELECT state FROM run WHERE id = $1',
        [run.runId],
      );
      expect(row?.state).toBe(RunState.ENDED);
    },
    CASE_MS,
  );
});
