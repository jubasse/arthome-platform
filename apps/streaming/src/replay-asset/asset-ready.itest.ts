import { ReplayAssetReadySchema } from '@arthome-platform/events';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DateOutcome, ReplayAssetState, plusMinutes } from '@arthome/core';

import { READINESS_POLL_EVERY_MS } from './recording-calls.js';
import {
  CASE_MS,
  CHANNEL,
  STARTUP_MS,
  assetOf,
  endRun,
  outboxTypesOf,
  recordedAndReady,
  recordingStarted,
  refOf,
  seedDate,
  setOutcome,
  startReplayDesk,
  stopReplayDesk,
  type ReplayDesk,
} from '../itest/replay-desk.js';

/**
 * Requirement 4: readiness through the port commits `ready`, the dates and the outbox row in one
 * transaction, the closing counted from the run's real end.
 */

let desk: ReplayDesk;

beforeAll(async () => {
  desk = await startReplayDesk('streaming_asset_ready_itest');
}, STARTUP_MS);

afterAll(async () => {
  await stopReplayDesk(desk);
});

const MINUTE_MS = 60_000;

async function announcementOf(dateId: string) {
  const [row] = await desk.dataSource.query<{ payload: Buffer; aggregatetype: string }[]>(
    `SELECT payload, aggregatetype FROM outbox_event
      WHERE aggregateid = $1 AND type = 'streaming.replay.asset_ready.v1'`,
    [dateId],
  );
  return row;
}

describe('the replay asset ready', () => {
  it(
    'is announced with its duration, from now, to a closing counted from the run end',
    async () => {
      const date = await seedDate(desk, { windowHours: 48 });
      await recordingStarted(desk, date);
      await endRun(desk, date, 60);
      desk.clock.advance(60 * MINUTE_MS);
      await desk.passes.closeRecordings();
      await desk.calls.pass();
      const processing = await assetOf(desk, date.dateId);
      expect(processing?.state).toBe(ReplayAssetState.PROCESSING);
      expect(processing?.stopped_at).toEqual(new Date(desk.clock.now()));

      await desk.calls.pass();
      expect((await assetOf(desk, date.dateId))?.state).toBe(ReplayAssetState.PROCESSING);
      expect(await outboxTypesOf(desk, date.dateId)).toEqual([]);

      desk.fake.markReady(await refOf(desk, date.dateId), 3_540);
      desk.clock.advance(READINESS_POLL_EVERY_MS);
      await desk.calls.pass();

      const ready = await assetOf(desk, date.dateId);
      expect(ready).toMatchObject({
        state: ReplayAssetState.READY,
        duration_sec: 3_540,
        available_from: new Date(desk.clock.now()),
        expires_at: new Date(plusMinutes(date.startsAt, 60 + 48 * 60)),
        announced_at: new Date(desk.clock.now()),
        call_attempts: 0,
        call_next_attempt_at: null,
      });
      const row = await announcementOf(date.dateId);
      expect(row?.aggregatetype).toBe('streaming.run');
      const message = fromBinary(ReplayAssetReadySchema, row?.payload ?? new Uint8Array());
      expect(message).toMatchObject({
        dateId: date.dateId,
        channelId: CHANNEL,
        durationSec: 3_540,
      });
      expect(message.availableFrom && timestampDate(message.availableFrom).toISOString()).toBe(
        desk.clock.now(),
      );
      expect(message.expiresAt && timestampDate(message.expiresAt).toISOString()).toBe(
        plusMinutes(date.startsAt, 60 + 48 * 60),
      );
      expect(row?.payload.toString('latin1')).not.toContain('rec_');
    },
    CASE_MS,
  );

  it(
    'closes from the actual end of a live that overran its runtime, never from the scheduled one',
    async () => {
      const date = await seedDate(desk, { windowHours: 24 });
      const overrunMin = date.runtimeMin + 45;
      await recordedAndReady(desk, date, overrunMin, 8_000);
      const ready = await assetOf(desk, date.dateId);
      expect(ready?.expires_at).toEqual(new Date(plusMinutes(date.startsAt, overrunMin + 24 * 60)));
      expect(ready?.expires_at).not.toEqual(
        new Date(plusMinutes(date.startsAt, date.runtimeMin + 24 * 60)),
      );
    },
    CASE_MS,
  );

  it(
    'asks again, uncounted, while the provider is still processing',
    async () => {
      const date = await seedDate(desk);
      await recordingStarted(desk, date);
      await endRun(desk, date, 30);
      await desk.passes.closeRecordings();
      await desk.calls.pass();
      await desk.calls.pass();

      expect(await assetOf(desk, date.dateId)).toMatchObject({
        state: ReplayAssetState.PROCESSING,
        call_attempts: 0,
        call_next_attempt_at: new Date(desk.clock.nowMs() + READINESS_POLL_EVERY_MS),
      });
      expect(await desk.calls.pass()).toBe(0);
    },
    CASE_MS,
  );

  it(
    'leaves no outbox row when the readiness rolls back',
    async () => {
      const date = await seedDate(desk);
      await recordingStarted(desk, date);
      await endRun(desk, date, 30);
      await desk.passes.closeRecordings();
      await desk.calls.pass();
      desk.fake.markReady(await refOf(desk, date.dateId), 100);

      await desk.dataSource.query(
        'ALTER TABLE replay_asset ADD CONSTRAINT refuse_ready CHECK (state <> $$ready$$) NOT VALID',
      );
      try {
        await desk.calls.pass();
      } finally {
        await desk.dataSource.query('ALTER TABLE replay_asset DROP CONSTRAINT refuse_ready');
      }

      expect((await assetOf(desk, date.dateId))?.state).toBe(ReplayAssetState.PROCESSING);
      expect(await announcementOf(date.dateId)).toBeUndefined();
    },
    CASE_MS,
  );

  it(
    'goes to deleting with no event when its window has closed before the provider was ready',
    async () => {
      const date = await seedDate(desk, { windowHours: 1 });
      await recordingStarted(desk, date);
      await endRun(desk, date, 30);
      await desk.passes.closeRecordings();
      await desk.calls.pass();
      desk.fake.markReady(await refOf(desk, date.dateId), 1_800);
      desk.clock.advance(2 * 60 * MINUTE_MS);

      await desk.calls.pass();

      expect(await assetOf(desk, date.dateId)).toMatchObject({
        state: ReplayAssetState.DELETING,
        announced_at: null,
      });
      expect(await outboxTypesOf(desk, date.dateId)).toEqual([]);
    },
    CASE_MS,
  );

  it(
    'goes to deleting with no event when the date no longer has a replay by then',
    async () => {
      const date = await seedDate(desk);
      await recordingStarted(desk, date);
      await endRun(desk, date, 30);
      await desk.passes.closeRecordings();
      await desk.calls.pass();
      desk.fake.markReady(await refOf(desk, date.dateId), 100);
      await setOutcome(desk, date.dateId, DateOutcome.INTERRUPTED);

      await desk.calls.pass();

      expect(await assetOf(desk, date.dateId)).toMatchObject({
        state: ReplayAssetState.DELETING,
        announced_at: null,
      });
      expect(await announcementOf(date.dateId)).toBeUndefined();
      expect(await outboxTypesOf(desk, date.dateId)).toEqual([]);
    },
    CASE_MS,
  );
});
