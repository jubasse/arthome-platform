import { randomUUID } from 'node:crypto';

import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import {
  FixedClock,
  ReplayPolicy,
  RunState,
  plusMinutes,
  type DateOutcome,
  type Instant,
} from '@arthome/core';

import { STREAMING_SCHEMA } from './schema.js';
import { CLOCK } from '../clock.js';
import { FakeStreamingProvider } from '../media/fake-streaming-provider.js';
import { recordingRefOf, type RecordingRef } from '../media/media-ports.js';
import { MediaModule } from '../media/media.module.js';
import { RecordingCalls } from '../replay-asset/recording-calls.js';
import { ReplayAssetPasses } from '../replay-asset/replay-asset-passes.js';
import { RunSweeperModule } from '../run/run-sweeper.module.js';

/**
 * The replay asset's passes and provider calls on a real Postgres and the fake provider, on one
 *   `FixedClock`. No sweeper loop is bound: a suite steps each pass itself, so the order is its own.
 *   PS1's run and PS2's date are rows a suite seeds.
 */

export const STARTUP_MS = 240_000;
export const CASE_MS = 30_000;

export const NOW = '2026-09-29T19:00:00.000Z';
export const CHANNEL = '01a0f0cc-0000-7000-8000-000000000001';

export interface ReplayDesk {
  readonly stack: StartedStack;
  readonly dataSource: DataSource;
  readonly app: INestApplicationContext;
  readonly clock: FixedClock;
  readonly fake: FakeStreamingProvider;
  readonly passes: ReplayAssetPasses;
  readonly calls: RecordingCalls;
}

export async function startReplayDesk(database: string): Promise<ReplayDesk> {
  const stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const created = await createDatabase(stack.postgres, database);
  const dataSource = await applyMigrations(created, STREAMING_SCHEMA);
  const clock = new FixedClock(NOW);
  const app = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRootAsync({
        useFactory: () => dataSource.options,
        dataSourceFactory: () => Promise.resolve(dataSource),
      }),
      CqrsModule.forRoot(),
      MediaModule,
      RunSweeperModule,
    ],
    providers: [{ provide: CLOCK, useValue: clock }, ReplayAssetPasses, RecordingCalls],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  await app.init();
  return {
    stack,
    dataSource,
    app,
    clock,
    fake: app.get(FakeStreamingProvider),
    passes: app.get(ReplayAssetPasses),
    calls: app.get(RecordingCalls),
  };
}

export async function stopReplayDesk(desk: ReplayDesk | undefined): Promise<void> {
  await desk?.app.close();
  await desk?.stack.stop();
}

export interface SeededDate {
  readonly dateId: string;
  readonly streamPath: string;
  readonly startsAt: Instant;
  readonly runtimeMin: number;
}

export interface DateOptions {
  readonly policy?: ReplayPolicy;
  readonly windowHours?: number;
  readonly outcome?: DateOutcome | null;
  readonly runState?: RunState;
}

/** PS2's projection of a date and PS1's run on it, the run live since now unless told otherwise. */
export async function seedDate(
  desk: ReplayDesk,
  {
    policy = ReplayPolicy.UNIT,
    windowHours = 48,
    outcome = null,
    runState = RunState.ON_AIR,
  }: DateOptions = {},
): Promise<SeededDate> {
  const dateId = randomUUID();
  const streamPath = `live/${randomUUID()}`;
  const startsAt = desk.clock.now();
  const runtimeMin = 90;
  await desk.dataSource.query(
    `INSERT INTO entitlement_date (date_id, channel_id, starts_at, runtime_min, replay_policy,
                                   replay_window_hours, outcome, applied_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $3)`,
    [dateId, CHANNEL, startsAt, runtimeMin, policy, windowHours, outcome],
  );
  await desk.dataSource.query(
    `INSERT INTO run (id, date_id, channel_id, state, stream_path, ingest_protocol, monitor_path,
                      started_at, version)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'rtmps', 'll_hls', $5, 3)`,
    [dateId, CHANNEL, runState, streamPath, startsAt],
  );
  return { dateId, streamPath, startsAt, runtimeMin };
}

export function setOutcome(desk: ReplayDesk, dateId: string, outcome: DateOutcome): Promise<void> {
  return desk.dataSource.query('UPDATE entitlement_date SET outcome = $2 WHERE date_id = $1', [
    dateId,
    outcome,
  ]);
}

export function setRunState(desk: ReplayDesk, dateId: string, state: RunState): Promise<void> {
  return desk.dataSource.query('UPDATE run SET state = $2 WHERE date_id = $1', [dateId, state]);
}

/** The run ended `afterMin` minutes after it started. */
export async function endRun(
  desk: ReplayDesk,
  date: SeededDate,
  afterMin: number,
): Promise<Instant> {
  const endedAt = plusMinutes(date.startsAt, afterMin);
  await desk.dataSource.query(
    `UPDATE run SET state = $2, ended_at = $3, publisher_lost_at = $3 WHERE date_id = $1`,
    [date.dateId, RunState.ENDED, endedAt],
  );
  return endedAt;
}

export interface AssetRow {
  readonly state: string;
  readonly recording_ref: string | null;
  readonly recorded_until: Date | null;
  readonly stopped_at: Date | null;
  readonly duration_sec: number | null;
  readonly available_from: Date | null;
  readonly expires_at: Date | null;
  readonly announced_at: Date | null;
  readonly call_attempts: number;
  readonly call_next_attempt_at: Date | null;
  readonly call_dead_at: Date | null;
  readonly failed_call: string | null;
  readonly deleted_at: Date | null;
}

export async function assetOf(desk: ReplayDesk, dateId: string): Promise<AssetRow | undefined> {
  const [row] = await desk.dataSource.query<AssetRow[]>(
    'SELECT * FROM replay_asset WHERE date_id = $1',
    [dateId],
  );
  return row;
}

export async function refOf(desk: ReplayDesk, dateId: string): Promise<RecordingRef> {
  const ref = (await assetOf(desk, dateId))?.recording_ref;
  if (ref === null || ref === undefined) throw new Error('the asset holds no recording');
  return recordingRefOf(ref);
}

export function assetCount(desk: ReplayDesk, dateId: string): Promise<number> {
  return desk.dataSource
    .query<{ n: number }[]>('SELECT count(*)::int AS n FROM replay_asset WHERE date_id = $1', [
      dateId,
    ])
    .then(([row]) => row?.n ?? 0);
}

/** The date's outbox rows in the order written. */
export function outboxTypesOf(desk: ReplayDesk, dateId: string): Promise<string[]> {
  return desk.dataSource
    .query<{ type: string }[]>('SELECT type FROM outbox_event WHERE aggregateid = $1 ORDER BY id', [
      dateId,
    ])
    .then((rows) => rows.map(({ type }) => type));
}

/** On air and recording: the request pass, then the start call. */
export async function recordingStarted(desk: ReplayDesk, date: SeededDate): Promise<void> {
  await desk.passes.requestRecordings();
  await desk.calls.pass();
  const row = await assetOf(desk, date.dateId);
  if (row?.recording_ref == null) throw new Error('the recording did not start');
}

/** Ended `afterMin` minutes in, closed, stopped, and the provider done: ready after the poll. */
export async function recordedAndReady(
  desk: ReplayDesk,
  date: SeededDate,
  afterMin: number,
  durationSec: number,
): Promise<Instant> {
  await recordingStarted(desk, date);
  const endedAt = await endRun(desk, date, afterMin);
  desk.clock.advance(afterMin * 60_000);
  await desk.passes.closeRecordings();
  await desk.calls.pass();
  desk.fake.markReady(await refOf(desk, date.dateId), durationSec);
  await desk.calls.pass();
  return endedAt;
}
