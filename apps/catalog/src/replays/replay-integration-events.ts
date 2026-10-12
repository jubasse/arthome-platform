import { ReplayStateChangedSchema, ReplayState as WireReplayState } from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EntityManager } from 'typeorm';

import type { Instant } from '@arthome/core';

import type { ReplayEvent, ReplayStateChanged } from './replay.events.js';
import { writeCatalogEvent, type CatalogEvent } from '../catalog-events.js';
import { WIRE_REPLAY_POLICY, WIRE_REPLAY_STATE } from '../wire.js';

/** The outbox rows of a command that moved the `Replay` alone: the file's or the expiry's. */
export async function writeReplayIntegrationEvents(
  manager: EntityManager,
  events: readonly ReplayEvent[],
  traceparent: string | null,
): Promise<void> {
  for (const event of events) {
    await writeCatalogEvent(
      manager,
      replayStateChanged(event, traceparent),
      new Date(event.occurredAt),
    );
  }
}

const timestampOf = (instant: Instant) => timestampFromDate(new Date(instant));

export function replayStateChanged(
  event: ReplayStateChanged,
  traceparent: string | null,
): CatalogEvent {
  return {
    type: 'catalog.replay.state_changed.v1',
    key: event.dateId,
    payload: toBinary(
      ReplayStateChangedSchema,
      create(ReplayStateChangedSchema, {
        dateId: event.dateId,
        channelId: event.channelId,
        fromState:
          event.from === null ? WireReplayState.UNSPECIFIED : WIRE_REPLAY_STATE[event.from],
        toState: WIRE_REPLAY_STATE[event.to],
        version: BigInt(event.version),
        policy: WIRE_REPLAY_POLICY[event.policy],
        liveEndedAt: timestampOf(event.liveEndedAt),
        closesAt: timestampOf(event.closesAt),
        ...(event.onlineAt !== null && { onlineAt: timestampOf(event.onlineAt) }),
        ...(event.durationSec !== null && { durationSec: event.durationSec }),
        occurredAt: timestampOf(event.occurredAt),
      }),
    ),
    traceparent,
  };
}
