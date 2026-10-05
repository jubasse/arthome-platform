import {
  DateDraftedSchema,
  DateOutcomeDeclaredSchema,
  DateRescheduledSchema,
  DateScheduledSchema,
  PublicationEngagedSchema,
  PublicationEngagement,
} from '@arthome-platform/events';
import { Outcome, PermanentError, header, messageIdOf } from '@arthome-platform/messaging';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate, type Timestamp } from '@bufbuild/protobuf/wkt';
import type { CommandBus } from '@nestjs/cqrs';
import type { EachMessagePayload } from 'kafkajs';

import { ApiErrorCode, isDomainError, type Instant } from '@arthome/core';

import { ApplyCatalogDateFact, type CatalogDateFact } from './apply-catalog-date-fact.command.js';
import { dateOutcomeOf } from '../wire.js';

function stated(timestamp: Timestamp | undefined, field: string): Instant {
  if (timestamp === undefined) throw new Error(`no ${field}`);
  return timestampDate(timestamp).toISOString();
}

/** What each consumed type says to ticketing; null when it says nothing ticketing keeps. */
const READERS: Readonly<Record<string, (value: Uint8Array) => CatalogDateFact | null>> = {
  'catalog.date.drafted.v1': (value) => {
    const event = fromBinary(DateDraftedSchema, value);
    return {
      kind: 'drafted',
      dateId: event.dateId,
      channelId: event.channelId,
      statedAt: stated(event.occurredAt, 'occurred_at'),
    };
  },
  'catalog.publication.engaged.v1': (value) => {
    const event = fromBinary(PublicationEngagedSchema, value);
    if (!event.engaged.includes(PublicationEngagement.PRICES)) return null;
    return {
      kind: 'lock',
      dateId: event.dateId,
      statedAt: stated(event.occurredAt, 'occurred_at'),
    };
  },
  'catalog.date.scheduled.v1': (value) => {
    const event = fromBinary(DateScheduledSchema, value);
    return {
      kind: 'start',
      dateId: event.dateId,
      startsAt: stated(event.startsAt, 'starts_at'),
      statedAt: stated(event.occurredAt, 'occurred_at'),
    };
  },
  'catalog.date.rescheduled.v1': (value) => {
    const event = fromBinary(DateRescheduledSchema, value);
    return {
      kind: 'start',
      dateId: event.dateId,
      startsAt: stated(event.newStartsAt, 'new_starts_at'),
      statedAt: stated(event.occurredAt, 'occurred_at'),
    };
  },
  'catalog.date.outcome_declared.v1': (value) => {
    const event = fromBinary(DateOutcomeDeclaredSchema, value);
    const outcome = dateOutcomeOf(event.outcome);
    if (outcome === null) return null;
    return {
      kind: 'outcome',
      dateId: event.dateId,
      outcome,
      statedAt: stated(event.declaredAt, 'declared_at'),
    };
  },
};

/**
 * A fact about a date ticketing has not opened is retried, not dead-lettered: catalog drafts every
 *   date before anything else, so only a retry topic holding its `drafted` explains it, and that
 *   `drafted` is ahead of this fact on the retry partition of their shared key. Any other refusal
 *   is one no retry changes.
 */
export async function applyCatalogDateMessage(
  commands: CommandBus,
  payload: EachMessagePayload,
): Promise<Outcome> {
  const messageId = messageIdOf(payload);
  const type = header(payload, 'type');
  const read = type === null ? undefined : READERS[type];
  if (read === undefined) return Outcome.IGNORED;

  const value = payload.message.value;
  if (value === null) throw new PermanentError(`message ${messageId} has no value`);
  let fact: CatalogDateFact | null;
  try {
    fact = read(new Uint8Array(value));
  } catch (cause) {
    throw new PermanentError(`message ${messageId} does not read as ${type}: ${String(cause)}`, {
      cause,
    });
  }
  if (fact === null) return Outcome.IGNORED;

  try {
    return await commands.execute(
      new ApplyCatalogDateFact(messageId, payload.topic, header(payload, 'traceparent'), fact),
    );
  } catch (error) {
    if (!isDomainError(error)) throw error;
    if (error.code === ApiErrorCode.NOT_FOUND) {
      throw new Error(`message ${messageId} is about date ${fact.dateId}, not opened here yet`, {
        cause: error,
      });
    }
    throw new PermanentError(
      `message ${messageId} is about date ${fact.dateId}, refused ${error.code}`,
      { cause: error },
    );
  }
}
