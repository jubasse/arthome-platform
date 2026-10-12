import { randomUUID } from 'node:crypto';

import { serveEndpoints } from '@arthome-platform/http-edge';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DateOutcome, FixedClock, ReplayAssetState, ReplayPolicy, RunState } from '@arthome/core';

import { ORPHAN_DELETE_ATTEMPTS } from './recording-calls.js';
import { ROOM_IDLE_AFTER_MS } from './replay-asset-checks.js';
import { CLOCK } from '../clock.js';

/**
 * The three checks on a real Postgres, through the API's own readiness: each seeded fault turns it
 * `degraded` and it still answers 200.
 */

// Not imported from the replay desk: its module graph reads `DATABASE_URL` before this suite sets it.
const STARTUP_MS = 240_000;
const CASE_MS = 30_000;
const NOW = '2026-09-29T19:00:00.000Z';
const CHANNEL = '01a0f0cc-0000-7000-8000-000000000001';

let stack: StartedStack;
let app: NestFastifyApplication;
let dataSource: DataSource;
const clock = new FixedClock(NOW);

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'streaming_ops_checks_itest');
  process.env.DATABASE_URL = database.url;
  const { STREAMING_SCHEMA } = await import('../itest/schema.js');
  dataSource = await applyMigrations(database, STREAMING_SCHEMA);
  const { AppModule } = await import('../app.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  serveEndpoints(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, STARTUP_MS);

afterAll(async () => {
  await app?.close();
  await stack?.stop();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE replay_asset, orphan_recording, run, entitlement_date CASCADE');
});

async function readiness(): Promise<{ status: number; checks: Record<string, unknown> }> {
  const answer = await app.inject({ method: 'GET', url: '/health/readiness' });
  const { checks } = answer.json<{ data: { checks: { name: string }[] } }>().data;
  return {
    status: answer.statusCode,
    checks: Object.fromEntries(checks.map((check) => [check.name, check])),
  };
}

async function seedDate(startsAt: string, outcome: string | null = null): Promise<string> {
  const dateId = randomUUID();
  await dataSource.query(
    `INSERT INTO entitlement_date (date_id, channel_id, starts_at, runtime_min, replay_policy,
                                   replay_window_hours, outcome, applied_at)
     VALUES ($1, $2, $3, 90, $5, 48, $4, $3)`,
    [dateId, CHANNEL, startsAt, outcome, ReplayPolicy.UNIT],
  );
  return dateId;
}

async function seedRun(dateId: string, state: string): Promise<void> {
  await dataSource.query(
    `INSERT INTO run (id, date_id, channel_id, state, stream_path, ingest_protocol, monitor_path,
                      version)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'rtmps', 'll_hls', 1)`,
    [dateId, CHANNEL, state, `live/${randomUUID()}`],
  );
}

describe('the replay ops checks', () => {
  it(
    'are up with nothing wrong',
    async () => {
      const { status, checks } = await readiness();
      expect(status).toBe(200);
      for (const name of ['replay_assets_failed', 'orphan_recordings', 'rooms_idle']) {
        expect(checks[name]).toMatchObject({ status: 'up' });
      }
    },
    CASE_MS,
  );

  it(
    'turn degraded on a failed asset, readiness still 200',
    async () => {
      const dateId = await seedDate(NOW);
      await dataSource.query(
        `INSERT INTO replay_asset (date_id, channel_id, state, recorded_from, call_dead_at, failed_call)
         VALUES ($1, $2, $3, $4, $4, 'status')`,
        [dateId, CHANNEL, ReplayAssetState.FAILED, NOW],
      );
      const { status, checks } = await readiness();
      expect(status).toBe(200);
      expect(checks.replay_assets_failed).toMatchObject({
        status: 'degraded',
        detail: { failed: 1, oldestDateId: dateId },
      });
    },
    CASE_MS,
  );

  it(
    'turn degraded on a lost orphan, without its reference',
    async () => {
      const dateId = await seedDate(NOW);
      for (let repeat = 0; repeat < 2; repeat += 1) {
        await dataSource.query(
          `INSERT INTO orphan_recording (date_id, recording_ref, attempts)
           VALUES ($1, 'rec_secret', $2) ON CONFLICT (recording_ref) DO NOTHING`,
          [dateId, ORPHAN_DELETE_ATTEMPTS],
        );
      }
      const { status, checks } = await readiness();
      expect(status).toBe(200);
      expect(checks.orphan_recordings).toMatchObject({
        status: 'degraded',
        detail: { orphans: 1, oldestDateId: dateId },
      });
      expect(JSON.stringify(checks.orphan_recordings)).not.toContain('rec_');
    },
    CASE_MS,
  );

  it(
    'turn degraded on an idle room past the threshold, and only then',
    async () => {
      const longAgo = new Date(clock.nowMs() - ROOM_IDLE_AFTER_MS - 1_000).toISOString();
      const recent = new Date(clock.nowMs() - ROOM_IDLE_AFTER_MS + 60_000).toISOString();
      const idle = await seedDate(longAgo);
      await seedRun(idle, RunState.IDLE);
      await seedRun(await seedDate(recent), RunState.IDLE);
      await seedRun(await seedDate(longAgo), RunState.ON_AIR);
      await seedRun(await seedDate(longAgo, DateOutcome.CANCELLED), RunState.REHEARSAL);

      const { status, checks } = await readiness();
      expect(status).toBe(200);
      expect(checks.rooms_idle).toMatchObject({
        status: 'degraded',
        detail: { rooms: 1, oldestDateId: idle },
      });
    },
    CASE_MS,
  );
});
