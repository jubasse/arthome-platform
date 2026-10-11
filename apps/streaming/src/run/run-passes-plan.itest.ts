import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RunState } from '@arthome/core';

import { LIVE_RUNS_SQL, PRESENCE_DUE_SQL, RUN_PASS_BATCH } from './run-passes.js';
import { STREAMING_SCHEMA } from '../itest/schema.js';

/**
 * Both passes read their candidates through their partial index on a table filled with ended runs,
 * the history every pass would otherwise read each second.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;
const ENDED_RUNS = 50_000;
const LIVE_RUNS = 20;

let stack: StartedStack;
let dataSource: DataSource;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'streaming_run_passes_plan_itest');
  dataSource = await applyMigrations(database, STREAMING_SCHEMA);
  const insert = (count: number, state: RunState, ended: boolean) =>
    dataSource.query(
      `INSERT INTO run (id, date_id, channel_id, state, stream_path, ingest_protocol, monitor_path,
                        started_at, ended_at, publisher_lost_at, version)
       SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $2, md5(random()::text || n),
              'rtmps', 'll_hls', now() - interval '3 hours',
              CASE WHEN $3 THEN now() - interval '1 hour' END, now() - interval '1 hour', 3
         FROM generate_series(1, $1) AS n`,
      [count, state, ended],
    );
  await insert(ENDED_RUNS, RunState.ENDED, true);
  await insert(LIVE_RUNS, RunState.ON_AIR, false);
  await insert(LIVE_RUNS, RunState.INTERRUPTED, false);
  await dataSource.query('ANALYZE run');
}, STARTUP_MS);

afterAll(async () => {
  await dataSource?.destroy();
  await stack?.stop();
});

async function indexesOf(sql: string, parameters: unknown[]): Promise<string> {
  const [explained] = await dataSource.query<{ 'QUERY PLAN': unknown }[]>(
    `EXPLAIN (FORMAT JSON) ${sql}`,
    parameters,
  );
  return JSON.stringify(explained?.['QUERY PLAN']);
}

describe('the run passes on a filled table', () => {
  it(
    'reads the publishers lost on air through idx_run_publisher_lost',
    async () => {
      const plan = await indexesOf(PRESENCE_DUE_SQL, [
        new Date('2026-09-29T19:00:00.000Z'),
        new Date('2026-09-29T18:59:50.000Z'),
        RUN_PASS_BATCH,
      ]);
      expect(plan).toContain('"Index Name":"idx_run_publisher_lost"');
      expect(plan).not.toContain('"Seq Scan"');
    },
    CASE_MS,
  );

  it(
    'reads the live runs through run_live',
    async () => {
      const plan = await indexesOf(LIVE_RUNS_SQL, [null, RUN_PASS_BATCH]);
      expect(plan).toContain('"Index Name":"run_live"');
      expect(plan).not.toContain('"Seq Scan"');
    },
    CASE_MS,
  );
});
