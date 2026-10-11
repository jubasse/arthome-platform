import { ReplayAssetReadySchema, ReplayExpiredSchema } from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EntityManager } from 'typeorm';

import type { Instant } from '@arthome/core';

import { writeStreamingEvent } from '../streaming-events.js';

export interface AssetReady {
  readonly dateId: string;
  readonly channelId: string;
  readonly durationSec: number;
  readonly availableFrom: Instant;
  readonly expiresAt: Instant;
}

function timestampOf(instant: Instant) {
  return timestampFromDate(new Date(instant));
}

/** `asset_ready.v1` on the transaction's manager, keyed by the date, in the readiness's own transaction. */
export async function writeAssetReady(
  manager: EntityManager,
  ready: AssetReady,
  occurredAt: Instant,
): Promise<void> {
  await writeStreamingEvent(
    manager,
    {
      type: 'streaming.replay.asset_ready.v1',
      key: ready.dateId,
      traceparent: null,
      payload: toBinary(
        ReplayAssetReadySchema,
        create(ReplayAssetReadySchema, {
          dateId: ready.dateId,
          channelId: ready.channelId,
          durationSec: ready.durationSec,
          availableFrom: timestampOf(ready.availableFrom),
          expiresAt: timestampOf(ready.expiresAt),
          occurredAt: timestampOf(occurredAt),
        }),
      ),
    },
    new Date(occurredAt),
  );
}

/** `expired.v1`, in the transaction that moves an announced asset to `deleting`. */
export async function writeReplayExpired(
  manager: EntityManager,
  dateId: string,
  occurredAt: Instant,
): Promise<void> {
  await writeStreamingEvent(
    manager,
    {
      type: 'streaming.replay.expired.v1',
      key: dateId,
      traceparent: null,
      payload: toBinary(
        ReplayExpiredSchema,
        create(ReplayExpiredSchema, { dateId, occurredAt: timestampOf(occurredAt) }),
      ),
    },
    new Date(occurredAt),
  );
}
