import {
  DateOutcomeDeclaredSchema,
  DateReplayPolicySetSchema,
  DateRescheduledSchema,
  DateRightsChangedSchema,
  DateScheduledSchema,
  PublicationStateChangedSchema,
  SeatActivatedSchema,
  SeatCancelledSchema,
  SubscriptionChangedSchema,
  type SeatActivated,
  type SeatCancelled,
  type TerritoryRights as WireTerritoryRights,
} from '@arthome-platform/events';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate, type Timestamp } from '@bufbuild/protobuf/wkt';

import {
  blackoutReasonOf,
  dateOutcomeOf,
  openingsOf,
  planTierOf,
  publicationStateOf,
  replayPolicyOf,
  rightsScopeOf,
  subscriptionStateOf,
} from './entitlement-wire.js';
import { RecordDateFact, type RightsFacts } from './record-date-fact.command.js';
import { RecordSeatFact } from './record-seat-fact.command.js';
import { RecordSubscriptionFact } from './record-subscription-fact.command.js';
import type { Reader } from '../consumed-messages.js';
import type { Delivery } from '../delivery.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id that is not a UUID, an empty `account_id` first, would open nothing: it does not read. */
function idOf(value: string, field: string): string {
  if (!UUID.test(value)) throw new Error(`${field} is not a UUID: ${JSON.stringify(value)}`);
  return value;
}

/** A fact with no instant cannot be ordered against another: it does not read as its type. */
function instantOf(timestamp: Timestamp | undefined, field: string): Date {
  if (timestamp === undefined) throw new Error(`no ${field}`);
  return timestampDate(timestamp);
}

function rightsOf(rights: WireTerritoryRights | undefined): RightsFacts {
  return {
    scope: rights === undefined ? null : rightsScopeOf(rights.scope),
    blackoutCountries: rights?.blackoutCountries.map((country) => country.toUpperCase()) ?? [],
    reason: rights === undefined ? null : blackoutReasonOf(rights.reason),
  };
}

function seatActivatedRead(delivery: Delivery, event: SeatActivated): RecordSeatFact {
  return new RecordSeatFact(delivery, {
    type: 'ticketing.seat.activated.v1',
    seatId: idOf(event.seatId, 'seat_id'),
    accountId: idOf(event.accountId, 'account_id'),
    dateId: idOf(event.dateId, 'date_id'),
    statedAt: instantOf(event.occurredAt, 'occurred_at'),
  });
}

/**
 * An empty account opens nothing, which is why an activation does not read without one; a
 *   cancellation only ends, so it needs the seat alone and the handler ends the kept row by it.
 */
function seatCancelledRead(delivery: Delivery, event: SeatCancelled): RecordSeatFact {
  const seatId = idOf(event.seatId, 'seat_id');
  const statedAt = event.occurredAt === undefined ? null : timestampDate(event.occurredAt);
  if (!UUID.test(event.accountId) || !UUID.test(event.dateId) || statedAt === null) {
    return new RecordSeatFact(delivery, { type: 'ticketing.seat.cancelled.v1', seatId, statedAt });
  }
  return new RecordSeatFact(delivery, {
    type: 'ticketing.seat.cancelled.v1',
    seatId,
    accountId: event.accountId,
    dateId: event.dateId,
    statedAt,
  });
}

/** The entitlement projection's nine types; null for a fact this build keeps nothing of. */
export const ENTITLEMENT_READERS: Readonly<Record<string, Reader>> = {
  'ticketing.seat.activated.v1': (value, delivery) =>
    seatActivatedRead(delivery, fromBinary(SeatActivatedSchema, value)),
  'ticketing.seat.cancelled.v1': (value, delivery) =>
    seatCancelledRead(delivery, fromBinary(SeatCancelledSchema, value)),
  'ticketing.subscription.changed.v1': (value, delivery) => {
    const event = fromBinary(SubscriptionChangedSchema, value);
    return new RecordSubscriptionFact(delivery, {
      type: 'ticketing.subscription.changed.v1',
      accountId: idOf(event.accountId, 'account_id'),
      plan: planTierOf(event.plan),
      state: subscriptionStateOf(event.state),
      openings: openingsOf(event.opens),
      paidThrough: event.paidThrough === undefined ? null : timestampDate(event.paidThrough),
      statedAt: instantOf(event.occurredAt, 'occurred_at'),
    });
  },
  'catalog.date.scheduled.v1': (value, delivery) => {
    const event = fromBinary(DateScheduledSchema, value);
    return new RecordDateFact(delivery, {
      type: 'catalog.date.scheduled.v1',
      dateId: idOf(event.dateId, 'date_id'),
      channelId: event.channelId,
      startsAt: instantOf(event.startsAt, 'starts_at'),
      runtimeMin: event.runtimeMin,
      replay: { policy: replayPolicyOf(event.replayPolicy), windowHours: event.replayWindowHours },
      rights: rightsOf(event.rights),
      statedAt: instantOf(event.occurredAt, 'occurred_at'),
    });
  },
  'catalog.date.rescheduled.v1': (value, delivery) => {
    const event = fromBinary(DateRescheduledSchema, value);
    return new RecordDateFact(delivery, {
      type: 'catalog.date.rescheduled.v1',
      dateId: idOf(event.dateId, 'date_id'),
      startsAt: instantOf(event.newStartsAt, 'new_starts_at'),
      statedAt: instantOf(event.occurredAt, 'occurred_at'),
    });
  },
  'catalog.date.replay_policy_set.v1': (value, delivery) => {
    const event = fromBinary(DateReplayPolicySetSchema, value);
    return new RecordDateFact(delivery, {
      type: 'catalog.date.replay_policy_set.v1',
      dateId: idOf(event.dateId, 'date_id'),
      replay: { policy: replayPolicyOf(event.policy), windowHours: event.windowHours },
      statedAt: instantOf(event.occurredAt, 'occurred_at'),
    });
  },
  'catalog.date.rights_changed.v1': (value, delivery) => {
    const event = fromBinary(DateRightsChangedSchema, value);
    return new RecordDateFact(delivery, {
      type: 'catalog.date.rights_changed.v1',
      dateId: idOf(event.dateId, 'date_id'),
      rights: rightsOf(event.rights),
      statedAt: instantOf(event.occurredAt, 'occurred_at'),
    });
  },
  'catalog.publication.state_changed.v1': (value, delivery) => {
    const event = fromBinary(PublicationStateChangedSchema, value);
    return new RecordDateFact(delivery, {
      type: 'catalog.publication.state_changed.v1',
      dateId: idOf(event.dateId, 'date_id'),
      channelId: event.channelId,
      state: publicationStateOf(event.toState),
      version: event.version,
      statedAt: instantOf(event.occurredAt, 'occurred_at'),
    });
  },
  'catalog.date.outcome_declared.v1': (value, delivery) => {
    const event = fromBinary(DateOutcomeDeclaredSchema, value);
    const outcome = dateOutcomeOf(event.outcome);
    if (outcome === null) return null;
    return new RecordDateFact(delivery, {
      type: 'catalog.date.outcome_declared.v1',
      dateId: idOf(event.dateId, 'date_id'),
      channelId: event.channelId,
      outcome,
      statedAt: instantOf(event.declaredAt, 'declared_at'),
    });
  },
};
