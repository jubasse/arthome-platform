import { ReplayAssetReadySchema } from '@arthome-platform/events';
import { createTopics, registerOutboxConnector, waitForMessage } from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Kafka, logLevel } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { READINESS_POLL_EVERY_MS } from './recording-calls.js';
import {
  CASE_MS,
  CHANNEL,
  STARTUP_MS,
  endRun,
  recordingStarted,
  refOf,
  seedDate,
  startReplayDesk,
  stopReplayDesk,
  type ReplayDesk,
} from '../itest/replay-desk.js';
import { SERVICE } from '../service.js';

/**
 * The `asset_ready` fact, past the outbox row `asset-ready.itest.ts` stops at: through Debezium to
 * its topic, with the key and the headers a consumer reads. The connector is registered on the
 * empty outbox, so the row the test commits is in the slot's stream.
 */

const TOPIC = 'arthome.streaming.run';
const TYPE = 'streaming.replay.asset_ready.v1';
const DELIVERY_MS = 120_000;

let desk: ReplayDesk;
let kafka: Kafka;

beforeAll(async () => {
  desk = await startReplayDesk('streaming_asset_ready_kafka_itest', { connect: true });
  kafka = new Kafka({
    clientId: 'streaming-asset-ready-kafka',
    brokers: [...desk.stack.kafka.brokers],
    logLevel: logLevel.NOTHING,
  });
  await createTopics(kafka, [{ topic: TOPIC, partitions: 12 }]);
  await registerOutboxConnector(desk.stack.connect, SERVICE, desk.database, 180_000);
}, STARTUP_MS);

afterAll(async () => {
  await stopReplayDesk(desk);
});

describe('the replay asset ready, on its topic', () => {
  it(
    'reaches arthome.streaming.run keyed by the date, typed, with the row it committed',
    async () => {
      const date = await seedDate(desk, { windowHours: 48 });
      await recordingStarted(desk, date);
      await endRun(desk, date, 60);
      desk.clock.advance(60 * 60_000);
      await desk.passes.closeRecordings();
      await desk.calls.pass();
      desk.fake.markReady(await refOf(desk, date.dateId), 3_540);
      desk.clock.advance(READINESS_POLL_EVERY_MS);
      await desk.calls.pass();

      const [row] = await desk.dataSource.query<{ id: string; payload: Buffer }[]>(
        `SELECT id, payload FROM outbox_event WHERE aggregateid = $1 AND type = $2`,
        [date.dateId, TYPE],
      );
      const [asset] = await desk.dataSource.query<
        { duration_sec: number; available_from: Date; expires_at: Date }[]
      >('SELECT duration_sec, available_from, expires_at FROM replay_asset WHERE date_id = $1', [
        date.dateId,
      ]);

      const message = await waitForMessage(kafka, {
        topic: TOPIC,
        matches: ({ key, headers }) => key === date.dateId && headers.type === TYPE,
        timeoutMs: DELIVERY_MS,
      });

      expect(message.key).toBe(date.dateId);
      expect(message.headers.type).toBe(TYPE);
      expect(message.headers['message-id']).toBe(row?.id);
      const value = message.value ?? Buffer.alloc(0);
      const decoded = fromBinary(ReplayAssetReadySchema, value);
      expect(decoded).toMatchObject({ dateId: date.dateId, channelId: CHANNEL });
      expect(decoded.durationSec).toBe(asset?.duration_sec);
      expect(decoded.availableFrom && timestampDate(decoded.availableFrom)).toEqual(
        asset?.available_from,
      );
      expect(decoded.expiresAt && timestampDate(decoded.expiresAt)).toEqual(asset?.expires_at);
      expect(value.toString('latin1')).not.toContain('rec_');
    },
    CASE_MS + DELIVERY_MS,
  );
});
