import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EdgeRenewalMode, PlaybackProtocol, QualityCap } from '@arthome/contracts/streaming';
import { IdentityErrorCode, PlaybackSessionState, Surface, WatchScope } from '@arthome/core';

import { LEASE_SWEEP_BATCH } from './lease-sweep.js';
import { EXPIRE_LAPSED_SQL, REVOKE_DEVICE_SQL } from './playback-sessions.js';
import { STREAMING_SCHEMA } from '../itest/schema.js';

/**
 * The sweep and a device's revocation read through their partial index on a table filled with
 *   closed leases, the history the sweep would otherwise read every five seconds.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;
const CLOSED_LEASES = 200_000;
const ACTIVE_LEASES = 50;

let stack: StartedStack;
let dataSource: DataSource;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'streaming_lease_sweep_plan_itest');
  dataSource = await applyMigrations(database, STREAMING_SCHEMA);
  const insert = (count: number, state: PlaybackSessionState) =>
    dataSource.query(
      `INSERT INTO playback_session (id, account_id, profile_id, device_id, date_id, state, scope,
                                     session_scope, protocol, quality_cap, edge_renewal_mode,
                                     surface, token_id, token_expires_at, lease_expires_at,
                                     opened_at, last_renewed_at, closed_at)
       SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
              gen_random_uuid(), $2, $3, md5(random()::text || n), $4, $5, $6, $7,
              gen_random_uuid(), now() - interval '1 hour',
              now() - interval '1 hour' + (n % 600) * interval '1 second',
              now() - interval '3 hours', now() - interval '1 hour',
              CASE WHEN $2 = '${PlaybackSessionState.ACTIVE}' THEN NULL ELSE now() END
         FROM generate_series(1, $1) AS n`,
      [
        count,
        state,
        WatchScope.FULL,
        PlaybackProtocol.HLS,
        QualityCap.HD,
        EdgeRenewalMode.QUERY_TOKEN,
        Surface.STOREFRONT_TV,
      ],
    );
  await insert(CLOSED_LEASES, PlaybackSessionState.EXPIRED);
  await insert(ACTIVE_LEASES, PlaybackSessionState.ACTIVE);
  await dataSource.query('ANALYZE playback_session');
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

describe('the lease statements on a filled table', () => {
  it(
    'sweeps the lapsed leases through playback_session_lease_due',
    async () => {
      const plan = await planOf(EXPIRE_LAPSED_SQL, [
        new Date('2026-12-12T19:00:00.000Z'),
        LEASE_SWEEP_BATCH,
      ]);
      expect(plan).toContain('"Index Name":"playback_session_lease_due"');
      expect(plan).not.toContain('"Seq Scan"');
    },
    CASE_MS,
  );

  it(
    "revokes a device's leases through playback_session_active_by_device",
    async () => {
      const plan = await planOf(REVOKE_DEVICE_SQL, [
        '01a0f700-0000-7000-8000-000000000001',
        '01a0f701-0000-7000-8000-000000000001',
        IdentityErrorCode.SIGNED_OUT_ELSEWHERE,
        new Date('2026-12-12T19:00:00.000Z'),
        null,
        null,
      ]);
      expect(plan).toContain('"Index Name":"playback_session_active_by_device"');
      expect(plan).not.toContain('"Seq Scan"');
    },
    CASE_MS,
  );
});
