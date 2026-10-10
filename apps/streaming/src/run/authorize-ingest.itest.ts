import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RunState } from '@arthome/core';

import { IngestRefusal, RunIngestAuthorizer } from './ingest-authorizer.js';
import { STREAM_KEY_SECRET, insertStreamKey, streamKeyOf } from './stream-key.js';
import {
  CASE_MS,
  STARTUP_MS,
  STREAM_KEY_TEST_SECRET,
  preparedRun,
  startRunDesk,
  stopRunDesk,
  type PreparedRun,
  type RunDesk,
} from '../itest/run-desk.js';
import { IngestProtocol } from '../media/media-ports.js';

/**
 * The ingest authorisation the media plane asks before it accepts a feed, through the fake as a
 * real server calls it: what it refuses, the fake never accepts, and no log carries a key.
 */

let desk: RunDesk;
const logged: string[] = [];

beforeAll(async () => {
  desk = await startRunDesk('streaming_authorize_ingest_itest');
  const capture = (message: unknown) => {
    logged.push(String(message));
  };
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(capture);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(capture);
}, STARTUP_MS);

afterAll(async () => {
  vi.restoreAllMocks();
  await stopRunDesk(desk);
});

function authorize(run: PreparedRun, presentedKey: string) {
  return desk.app.get(RunIngestAuthorizer).authorize({
    streamPath: run.streamPath,
    presentedKey,
    protocol: IngestProtocol.RTMPS,
  });
}

async function presenceOf(run: PreparedRun): Promise<Date | null> {
  const [row] = await desk.dataSource.query<{ publisher_online_since: Date | null }[]>(
    'SELECT publisher_online_since FROM run WHERE id = $1',
    [run.runId],
  );
  return row?.publisher_online_since ?? null;
}

describe('the ingest authorizer', () => {
  it(
    "accepts the date's key, and the feed goes online with its protocol",
    async () => {
      const run = await preparedRun(desk);
      const decision = await desk.fake.publish(run.streamPath, run.key, {
        protocol: IngestProtocol.SRT,
      });
      expect(decision).toEqual({ accepted: true });
      expect(await presenceOf(run)).toEqual(new Date(desk.clock.now()));
      const [row] = await desk.dataSource.query<{ ingest_protocol: string }[]>(
        'SELECT ingest_protocol FROM run WHERE id = $1',
        [run.runId],
      );
      expect(row?.ingest_protocol).toBe(IngestProtocol.SRT);
    },
    CASE_MS,
  );

  it(
    "refuses another run's key and an unknown path, and the fake accepts nothing refused",
    async () => {
      const run = await preparedRun(desk);
      const other = await preparedRun(desk);

      expect(await authorize(run, other.key)).toEqual({
        accepted: false,
        reason: IngestRefusal.KEY_NOT_CURRENT,
      });
      const refused = await desk.fake.publish(run.streamPath, other.key, {
        protocol: IngestProtocol.RTMPS,
      });
      expect(refused.accepted).toBe(false);
      expect(await desk.fake.sample(run.streamPath)).toBeNull();
      expect(desk.fake.manifestGeneration(run.streamPath)).toBe(0);
      expect(await presenceOf(run)).toBeNull();

      const unknown = await desk.fake.publish('no-such-path', run.key, {
        protocol: IngestProtocol.RTMPS,
      });
      expect(unknown).toEqual({ accepted: false, reason: IngestRefusal.UNKNOWN_PATH });
    },
    CASE_MS,
  );

  it(
    'refuses a retired generation, and accepts the live one',
    async () => {
      const run = await preparedRun(desk);
      await desk.dataSource.transaction(async (manager) => {
        await manager.query(
          'UPDATE stream_key SET retired_at = now() WHERE run_id = $1 AND generation = 1',
          [run.runId],
        );
        await insertStreamKey(
          manager,
          desk.app.get<string>(STREAM_KEY_SECRET),
          run.runId,
          2,
          desk.clock.now(),
        );
      });

      expect(await authorize(run, run.key)).toEqual({
        accepted: false,
        reason: IngestRefusal.KEY_NOT_CURRENT,
      });
      expect(await authorize(run, streamKeyOf(STREAM_KEY_TEST_SECRET, run.runId, 2))).toEqual({
        accepted: true,
      });
    },
    CASE_MS,
  );

  it(
    'refuses an ended run, and a run that has a publisher online',
    async () => {
      const ended = await preparedRun(desk);
      await desk.dataSource.query('UPDATE run SET state = $2, ended_at = now() WHERE id = $1', [
        ended.runId,
        RunState.ENDED,
      ]);
      expect(await authorize(ended, ended.key)).toEqual({
        accepted: false,
        reason: IngestRefusal.RUN_ENDED,
      });

      const busy = await preparedRun(desk);
      expect(
        await desk.fake.publish(busy.streamPath, busy.key, { protocol: IngestProtocol.RTMPS }),
      ).toEqual({ accepted: true });
      expect(await authorize(busy, busy.key)).toEqual({
        accepted: false,
        reason: IngestRefusal.PUBLISHER_ONLINE,
      });
    },
    CASE_MS,
  );

  it(
    'logs each refusal with its reason, and never a key nor its digest',
    async () => {
      const run = await preparedRun(desk);
      const wrongKey = streamKeyOf(STREAM_KEY_TEST_SECRET, run.runId, 7);
      logged.length = 0;
      await authorize(run, wrongKey);

      expect(logged).toEqual([
        `ingest refused on run ${run.runId}: ${IngestRefusal.KEY_NOT_CURRENT}`,
      ]);
      const everything = logged.join('\n');
      expect(everything).not.toContain(wrongKey);
      expect(everything).not.toContain(run.key);
    },
    CASE_MS,
  );
});
