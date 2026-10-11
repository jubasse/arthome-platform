import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DateOutcome, ReplayAssetState, RunState } from '@arthome/core';

import {
  ENDED_RECORDINGS_SQL,
  EXPIRED_ASSETS_SQL,
  REPLAY_ASSET_PASS_BATCH,
  UNRECORDED_LIVE_RUNS_SQL,
  WITHDRAWN_ASSETS_SQL,
} from './replay-asset-passes.js';
import { ASSETS_DUE_SQL } from './replay-asset.store.js';
import { STREAMING_SCHEMA } from '../itest/schema.js';

/**
 * Each pass reads its candidates through its index on a table filled with deleted assets, the
 * history every pass would otherwise read each second.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;
const DELETED_ASSETS = 50_000;
const ACTIVE_ASSETS = 20;

let stack: StartedStack;
let dataSource: DataSource;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'streaming_asset_passes_plan_itest');
  dataSource = await applyMigrations(database, STREAMING_SCHEMA);
  await dataSource.query(
    `INSERT INTO run (id, date_id, channel_id, state, stream_path, ingest_protocol, monitor_path,
                      started_at, ended_at, version)
     SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $2, md5(random()::text || n),
            'rtmps', 'll_hls', now() - interval '3 hours',
            CASE WHEN $2 = $3 THEN now() - interval '1 hour' END, 3
       FROM generate_series(1, $1) AS n`,
    [50_000, RunState.ENDED, RunState.ENDED],
  );
  await dataSource.query(
    `INSERT INTO run (id, date_id, channel_id, state, stream_path, ingest_protocol, monitor_path,
                      started_at, version)
     SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $2, md5(random()::text || n),
            'rtmps', 'll_hls', now() - interval '3 hours', 3
       FROM generate_series(1, $1) AS n`,
    [ACTIVE_ASSETS, RunState.ON_AIR],
  );
  await dataSource.query(
    `INSERT INTO replay_asset (date_id, channel_id, state, recorded_from, deleted_at)
     SELECT gen_random_uuid(), gen_random_uuid(), $2, now() - interval '3 days', now()
       FROM generate_series(1, $1)`,
    [DELETED_ASSETS, ReplayAssetState.DELETED],
  );
  const insertActive = (state: ReplayAssetState, expires: boolean) =>
    dataSource.query(
      `INSERT INTO replay_asset (date_id, channel_id, state, recorded_from, expires_at,
                                 recording_ref)
       SELECT gen_random_uuid(), gen_random_uuid(), $2, now() - interval '3 hours',
              CASE WHEN $3 THEN now() - interval '1 hour' END, 'rec_x'
         FROM generate_series(1, $1)`,
      [ACTIVE_ASSETS, state, expires],
    );
  await insertActive(ReplayAssetState.RECORDING, false);
  await insertActive(ReplayAssetState.PROCESSING, false);
  await insertActive(ReplayAssetState.READY, true);
  await dataSource.query(
    `INSERT INTO entitlement_date (date_id, outcome, applied_at)
     SELECT date_id, $1, now() FROM replay_asset WHERE state = $2`,
    [DateOutcome.CANCELLED, ReplayAssetState.READY],
  );
  await dataSource.query('ANALYZE run');
  await dataSource.query('ANALYZE replay_asset');
  await dataSource.query('ANALYZE entitlement_date');
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

function expectNoScanOf(plan: string, table: string): void {
  expect(plan).not.toMatch(new RegExp(`"Node Type":"Seq Scan"[^}]*"Relation Name":"${table}"`));
}

describe('the replay asset passes on a filled table', () => {
  it(
    'reads the live runs with no asset through run_live and the asset primary key',
    async () => {
      const plan = await planOf(UNRECORDED_LIVE_RUNS_SQL, [null, REPLAY_ASSET_PASS_BATCH]);
      expect(plan).toContain('"Index Name":"run_live"');
      expectNoScanOf(plan, 'run');
      expectNoScanOf(plan, 'replay_asset');
    },
    CASE_MS,
  );

  it(
    'reads the recordings to close through replay_asset_calls_due',
    async () => {
      const plan = await planOf(ENDED_RECORDINGS_SQL, [REPLAY_ASSET_PASS_BATCH]);
      expect(plan).toContain('"Index Name":"replay_asset_calls_due"');
      expectNoScanOf(plan, 'replay_asset');
    },
    CASE_MS,
  );

  it(
    'reads the assets to withdraw through replay_asset_withdrawable',
    async () => {
      const plan = await planOf(WITHDRAWN_ASSETS_SQL, [
        [DateOutcome.CANCELLED, DateOutcome.INTERRUPTED],
        REPLAY_ASSET_PASS_BATCH,
      ]);
      expect(plan).toContain('"Index Name":"replay_asset_withdrawable"');
      expectNoScanOf(plan, 'replay_asset');
    },
    CASE_MS,
  );

  it(
    'reads the expired assets through replay_asset_expiring',
    async () => {
      const plan = await planOf(EXPIRED_ASSETS_SQL, [new Date(), REPLAY_ASSET_PASS_BATCH]);
      expect(plan).toContain('"Index Name":"replay_asset_expiring"');
      expectNoScanOf(plan, 'replay_asset');
    },
    CASE_MS,
  );

  it(
    'claims the calls due through replay_asset_calls_due',
    async () => {
      const plan = await planOf(ASSETS_DUE_SQL, [new Date(), REPLAY_ASSET_PASS_BATCH]);
      expect(plan).toContain('"Index Name":"replay_asset_calls_due"');
      expectNoScanOf(plan, 'replay_asset');
    },
    CASE_MS,
  );
});
