import {
  ActorSchema,
  IncidentRaisedSchema,
  IncidentResolvedSchema,
  LocalizedTextSchema,
  RunEndedSchema,
  RunStartedSchema,
  RunStateChangedSchema,
  TechnicalCheckPassedSchema,
  type Actor,
} from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate, type Timestamp } from '@bufbuild/protobuf/wkt';
import type { EntityManager } from 'typeorm';

import type { Instant } from '@arthome/core';

import {
  wireIncidentCause,
  wireIncidentKind,
  wireIncidentTrigger,
  wireIngestProtocol,
  wireMonitorPath,
  wireRunState,
  wireSurface,
} from './run-wire.js';
import type { RunActor, RunEvent } from './run.events.js';
import { assertNever } from '../assert-never.js';
import { writeStreamingEvent, type StreamingEvent } from '../streaming-events.js';

/**
 * Every consequence of a run's events inside its command's transaction: one outbox row per
 *   event with a wire form, keyed by the date, in the order applied. A command calls this
 *   once, after its save; the traceparent is the command's or the consumed message's.
 */
export async function recordRunEvents(
  manager: EntityManager,
  events: readonly RunEvent[],
  traceparent: string | null,
): Promise<void> {
  for (const event of events) {
    const wire = wireFormOf(event);
    if (wire !== null) {
      await writeStreamingEvent(
        manager,
        { ...wire, key: event.dateId, traceparent },
        new Date(event.occurredAt),
      );
    }
  }
}

function timestampOf(instant: Instant): Timestamp {
  return timestampFromDate(new Date(instant));
}

function actorOf({ accountId, surface }: RunActor): Actor {
  return create(ActorSchema, { accountId: accountId ?? '', surface: wireSurface(surface) });
}

/**
 * The event's type and Protobuf payload, or null for an event that stays inside the service. The
 *   viewer peaks of `run.ended` stay unset: no viewer count exists yet, and absent is not zero.
 */
function wireFormOf(event: RunEvent): Pick<StreamingEvent, 'type' | 'payload'> | null {
  switch (event.kind) {
    case 'RunPrepared':
      return null;
    case 'TechnicalCheckPassed':
      return {
        type: 'streaming.run.technical_check_passed.v1',
        payload: toBinary(
          TechnicalCheckPassedSchema,
          create(TechnicalCheckPassedSchema, {
            dateId: event.dateId,
            channelId: event.channelId,
            protocol: wireIngestProtocol(event.protocol),
            passedAt: timestampOf(event.occurredAt),
            checkedBy: actorOf(event.checkedBy),
          }),
        ),
      };
    case 'RunStarted':
      return {
        type: 'streaming.run.started.v1',
        payload: toBinary(
          RunStartedSchema,
          create(RunStartedSchema, {
            dateId: event.dateId,
            channelId: event.channelId,
            protocol: wireIngestProtocol(event.protocol),
            monitorPath: wireMonitorPath(event.monitorPath),
            startedAt: timestampOf(event.occurredAt),
            startedBy: actorOf(event.startedBy),
          }),
        ),
      };
    case 'RunEnded':
      return {
        type: 'streaming.run.ended.v1',
        payload: toBinary(
          RunEndedSchema,
          create(RunEndedSchema, {
            dateId: event.dateId,
            channelId: event.channelId,
            endedAt: timestampOf(event.endedAt),
            durationSec: event.durationSec,
            occurredAt: timestampOf(event.occurredAt),
            endedBy: actorOf(event.endedBy),
          }),
        ),
      };
    case 'RunStateChanged':
      return {
        type: 'streaming.run.state_changed.v1',
        payload: toBinary(
          RunStateChangedSchema,
          create(RunStateChangedSchema, {
            dateId: event.dateId,
            state: wireRunState(event.state),
            cause: event.cause === null ? 0 : wireIncidentCause(event.cause),
            afterGracePeriod: event.afterGracePeriod,
            occurredAt: timestampOf(event.occurredAt),
          }),
        ),
      };
    case 'IncidentRaised':
      return {
        type: 'streaming.incident.raised.v1',
        payload: toBinary(
          IncidentRaisedSchema,
          create(IncidentRaisedSchema, {
            incidentId: event.incident.id,
            dateId: event.dateId,
            channelId: event.channelId,
            kind: wireIncidentKind(event.incident.kind),
            cause: wireIncidentCause(event.incident.cause),
            trigger: wireIncidentTrigger(event.incident.trigger),
            ...(event.incident.message !== null && {
              message: create(LocalizedTextSchema, event.incident.message),
            }),
            raisedAt: timestampOf(event.occurredAt),
            raisedBy: actorOf(event.raisedBy),
          }),
        ),
      };
    case 'IncidentResolved':
      return {
        type: 'streaming.incident.resolved.v1',
        payload: toBinary(
          IncidentResolvedSchema,
          create(IncidentResolvedSchema, {
            incidentId: event.incidentId,
            dateId: event.dateId,
            resolvedAt: timestampOf(event.occurredAt),
            resolvedBy: actorOf(event.resolvedBy),
          }),
        ),
      };
    default:
      return assertNever(event);
  }
}
