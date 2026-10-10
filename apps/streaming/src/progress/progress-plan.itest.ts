import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IncidentCause, IncidentKind, IncidentTrigger, RunState } from '@arthome/core';

import { PROGRESS_ON_SQL } from './resume-points.js';
import { STREAMING_SCHEMA } from '../itest/schema.js';
import { VEILS_SQL } from '../preview/run-spans.js';

/**
 * The batch reads `resume_point` by its primary key and the budget reads a run's veils through
 *   `incident_by_run`, on tables filled with other viewers' and other runs' rows.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;
const OTHER_POINTS = 200_000;
const OTHER_INCIDENTS = 50_000;

let stack: StartedStack;
let dataSource: DataSource;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'streaming_progress_plan_itest');
  dataSource = await applyMigrations(database, STREAMING_SCHEMA);
  await dataSource.query(
    `INSERT INTO resume_point (owner_id, date_id, account_id, profile_id, device_id,
                               position_sec, completed, version, written_at)
     SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
            gen_random_uuid(), n % 7200, false, 1, now()
       FROM generate_series(1, $1) AS n`,
    [OTHER_POINTS],
  );
  await dataSource.query(
    `INSERT INTO run (id, date_id, channel_id, state, stream_path, ingest_protocol, monitor_path,
                      started_at, ended_at, version)
     SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $2, md5(n::text),
            'rtmps', 'll_hls', now() - interval '2 hours', now(), 1
       FROM generate_series(1, $1) AS n`,
    [OTHER_INCIDENTS, RunState.ENDED],
  );
  await dataSource.query(
    `INSERT INTO incident (id, run_id, date_id, kind, cause, trigger, raised_at, resolved_at)
     SELECT gen_random_uuid(), run.id, run.date_id, $1, $2, $3,
            now() - interval '1 hour', now()
       FROM run`,
    [IncidentKind.HOLD_SCREEN, IncidentCause.VENUE_FEED_LOST, IncidentTrigger.AUTO],
  );
  await dataSource.query('ANALYZE resume_point');
  await dataSource.query('ANALYZE run');
  await dataSource.query('ANALYZE incident');
}, STARTUP_MS);

afterAll(async () => {
  await dataSource?.destroy();
  await stack?.stop();
});

async function planOf(sql: string, parameters: unknown[]): Promise<string> {
  const [explained] = await dataSource.query<{ 'QUERY PLAN': unknown }[]>(
    `EXPLAIN (FORMAT JSON) ${sql}`,
    parameters,
  );
  return JSON.stringify(explained?.['QUERY PLAN']);
}

describe('the progress statements on filled tables', () => {
  it(
    "reads a profile's points on many dates through resume_point's primary key",
    async () => {
      const dateIds = Array.from(
        { length: 200 },
        (_, index) => `01a0f700-0000-7000-8000-${String(index).padStart(12, '0')}`,
      );

      const plan = await planOf(PROGRESS_ON_SQL, [
        '01a0f701-0000-7000-8000-000000000001',
        dateIds,
        '01a0f702-0000-7000-8000-000000000001',
      ]);

      expect(plan).toContain('"Index Name":"resume_point_pkey"');
      expect(plan).not.toContain('"Seq Scan"');
    },
    CASE_MS,
  );

  it(
    "reads a run's veils through incident_by_run",
    async () => {
      const [run] = await dataSource.query<{ date_id: string }[]>(
        'SELECT date_id FROM run LIMIT 1',
      );

      const plan = await planOf(VEILS_SQL, [run?.date_id]);

      expect(plan).toContain('"Index Name":"incident_by_run"');
      expect(plan).not.toContain('"Seq Scan"');
    },
    CASE_MS,
  );
});
