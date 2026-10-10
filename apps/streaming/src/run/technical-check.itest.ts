import { TechnicalCheckPassedSchema } from '@arthome-platform/events';
import { guardDeclaredResponses } from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { streamingServiceApi } from '@arthome/contracts/streaming-service-api';
import {
  DomainErrorCode,
  RunState,
  TECHNICAL_CHECK_BITRATE_FLOOR_KBPS_DEFAULT,
  TECHNICAL_CHECK_FAILURES,
  TechnicalCheckFailure,
} from '@arthome/core';

import {
  CASE_MS,
  CHANNEL,
  OPERATOR,
  STARTUP_MS,
  outboxOf,
  preparedRun,
  startRunDesk,
  stopRunDesk,
  studioCall,
  versionOf,
  type PreparedRun,
  type RunDesk,
} from '../itest/run-desk.js';
import { IngestProtocol, MediaCodec, type FeedSample } from '../media/media-ports.js';

/** D-114 from a fed sample: each failure of core's closed vocabulary, and what a pass writes. */

const responses = guardDeclaredResponses(streamingServiceApi);

let desk: RunDesk;

beforeAll(async () => {
  desk = await startRunDesk('streaming_technical_check_itest', { watch: responses });
}, STARTUP_MS);

afterAll(async () => {
  await stopRunDesk(desk);
});

type Reading = Omit<FeedSample, 'measuredAt' | 'protocol'>;

const CARRIED: Reading = {
  videoCodec: MediaCodec.H264,
  audioCodec: MediaCodec.AAC,
  ingestUpKbps: TECHNICAL_CHECK_BITRATE_FLOOR_KBPS_DEFAULT,
};

async function fed(reading: Reading | null): Promise<PreparedRun> {
  const run = await preparedRun(desk);
  if (reading !== null) {
    await desk.fake.publish(run.streamPath, run.key, { protocol: IngestProtocol.RTMPS });
    desk.fake.setFeedSample(run.streamPath, reading);
  }
  return run;
}

function check(run: PreparedRun) {
  return studioCall(desk, 'POST', `/v1/dates/${run.dateId}/run/technical-check`);
}

const FAILING: Readonly<Record<TechnicalCheckFailure, Reading | null>> = {
  [TechnicalCheckFailure.NO_FEED]: null,
  [TechnicalCheckFailure.CODEC_NOT_CARRIED]: { ...CARRIED, videoCodec: 'vp9' },
  [TechnicalCheckFailure.BITRATE_BELOW_FLOOR]: {
    ...CARRIED,
    ingestUpKbps: TECHNICAL_CHECK_BITRATE_FLOOR_KBPS_DEFAULT - 1,
  },
};

describe('runTechnicalCheck', () => {
  for (const failure of TECHNICAL_CHECK_FAILURES) {
    it(
      `fails ${failure} from its sample, recording nothing`,
      async () => {
        const run = await fed(FAILING[failure]);
        const response = await check(run);

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          data: { passed: false, passedAt: null, failures: [failure] },
        });
        expect(await versionOf(desk, run.dateId)).toBe(1);
        expect(await outboxOf(desk, run.dateId)).toEqual([]);
      },
      CASE_MS,
    );
  }

  it(
    'passes at the floor, recording the first pass and writing the event with passed_at',
    async () => {
      const run = await fed(CARRIED);
      const first = await check(run);
      expect(first.json()).toMatchObject({
        data: {
          passed: true,
          passedAt: desk.clock.now(),
          failures: [],
          sample: { ingestUpKbps: TECHNICAL_CHECK_BITRATE_FLOOR_KBPS_DEFAULT },
        },
      });

      desk.clock.advance(60_000);
      await check(run);
      const [row] = await desk.dataSource.query<
        { technical_check_passed_at: Date; version: number }[]
      >('SELECT technical_check_passed_at, version FROM run WHERE id = $1', [run.runId]);
      expect(row?.version).toBe(2);
      expect(row?.technical_check_passed_at.getTime()).toBe(desk.clock.nowMs() - 60_000);

      const events = await outboxOf(desk, run.dateId);
      expect(events.map(({ type }) => type)).toEqual([
        'streaming.run.technical_check_passed.v1',
        'streaming.run.technical_check_passed.v1',
      ]);
      const passed = fromBinary(TechnicalCheckPassedSchema, events[1]?.payload ?? new Uint8Array());
      expect(passed).toMatchObject({
        dateId: run.dateId,
        channelId: CHANNEL,
        checkedBy: { accountId: OPERATOR },
      });
      expect(passed.passedAt && timestampDate(passed.passedAt).toISOString()).toBe(
        desk.clock.now(),
      );
    },
    CASE_MS,
  );

  it(
    'is refused state.conflict on an ended run',
    async () => {
      const run = await fed(CARRIED);
      await desk.dataSource.query('UPDATE run SET state = $2, ended_at = now() WHERE id = $1', [
        run.runId,
        RunState.ENDED,
      ]);
      const response = await check(run);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: DomainErrorCode.STATE_CONFLICT } });
    },
    CASE_MS,
  );
});
