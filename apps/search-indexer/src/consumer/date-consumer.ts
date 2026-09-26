import { DateScheduledSchema, PublicationStateChangedSchema } from '@arthome-platform/events';
import type { Outcome } from '@arthome-platform/messaging';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { EachMessagePayload } from 'kafkajs';
import type { DataSource, EntityManager } from 'typeorm';

import { PublicationState } from '@arthome/core';

import { DateProjection, type ScheduledDateFields } from './date-projection.entity.js';
import { claimed, decodedOrRefused, incomingOf } from './incoming.js';
import { ShowProjection } from './show-projection.entity.js';
import { publicationStateOf, replayPolicyOf, rightsScopeOf, stated } from './wire.js';
import { dateDocumentOf } from '../index/date-document.js';
import type { Indices } from '../index/opensearch-client.js';

const DATE_SCHEDULED = 'catalog.date.scheduled.v1';
const STATE_CHANGED = 'catalog.publication.state_changed.v1';

export type DateFact =
  | {
      readonly type: typeof DATE_SCHEDULED;
      readonly dateId: string;
      /** DateScheduled's `occurred_at` in epoch milliseconds. */
      readonly version: number;
      readonly fields: ScheduledDateFields;
    }
  | {
      readonly type: typeof STATE_CHANGED;
      readonly dateId: string;
      /** The publication's own version after the transition. */
      readonly version: number;
      readonly state: PublicationState | null;
    };

export function dateFactOf(type: string, value: Uint8Array): DateFact {
  if (type === DATE_SCHEDULED) {
    const event = fromBinary(DateScheduledSchema, value);
    if (event.startsAt === undefined) throw new Error(`date ${event.dateId} has no starts_at`);
    return {
      type: DATE_SCHEDULED,
      dateId: event.dateId,
      version: stated(event.occurredAt, `date ${event.dateId}`).getTime(),
      fields: {
        show_id: event.showId,
        channel_id: event.channelId,
        venue_id: event.venueId,
        starts_at: timestampDate(event.startsAt).toISOString(),
        venue_timezone: event.venueClock?.venueTimezone ?? '',
        venue_city: event.venueCity,
        venue_country: event.venueCountry,
        runtime_min: event.runtimeMin,
        replay_policy: replayPolicyOf(event.replayPolicy),
        replay_window_hours: event.replayWindowHours,
        rights_scope: event.rights === undefined ? null : rightsScopeOf(event.rights.scope),
        blackout_countries: event.rights?.blackoutCountries ?? [],
        canonical_url: event.canonicalUrl,
      },
    };
  }
  const event = fromBinary(PublicationStateChangedSchema, value);
  return {
    type: STATE_CHANGED,
    dateId: event.dateId,
    version: Number(event.version),
    state: publicationStateOf(event.toState),
  };
}

/**
 * The date's facts and its publication's state move independently, each guarded by its own
 * version. DateScheduled sets the state only when none is known: a later transition that
 * overtook it on a retry topic must not be undone. Null when nothing moves.
 */
export function dateAfter(row: DateProjection, fact: DateFact): DateProjection | null {
  const takes = (version: string | null): boolean =>
    version === null || fact.version >= Number(version);
  if (fact.type === DATE_SCHEDULED) {
    if (!takes(row.scheduled_version)) return null;
    return {
      ...row,
      show_id: fact.fields.show_id,
      scheduled: fact.fields,
      scheduled_version: String(fact.version),
      publication_state: row.publication_state ?? PublicationState.SCHEDULED,
    };
  }
  if (!takes(row.publication_version)) return null;
  return { ...row, publication_state: fact.state, publication_version: String(fact.version) };
}

async function lockedDate(manager: EntityManager, dateId: string): Promise<DateProjection> {
  await manager.query('INSERT INTO date_projection (date_id) VALUES ($1) ON CONFLICT DO NOTHING', [
    dateId,
  ]);
  return manager.findOneOrFail(DateProjection, {
    where: { date_id: dateId },
    lock: { mode: 'pessimistic_write' },
  });
}

/**
 * Same order as the show consumer: the read model commits, then the document is written from
 * it. A date not yet scheduled is held and never indexed: before publication it is not public.
 */
export async function applyDateMessage(
  dataSource: DataSource,
  indices: Indices,
  payload: EachMessagePayload,
  now: Date = new Date(),
): Promise<Outcome> {
  const incoming = incomingOf(payload);
  const { type } = incoming;
  if (type !== DATE_SCHEDULED && type !== STATE_CHANGED) return 'ignored';
  const fact = decodedOrRefused(payload, incoming, (value) => dateFactOf(type, value));

  const result = await dataSource.transaction(async (manager) => {
    const firstDelivery = await claimed(manager, incoming, payload.topic);
    const row = await lockedDate(manager, fact.dateId);
    const next = firstDelivery ? dateAfter(row, fact) : row;
    if (next === null) return { outcome: 'superseded' as const, date: null, show: null };

    const date =
      firstDelivery && next.scheduled !== null
        ? { ...next, doc_version: String(Number(next.doc_version) + 1) }
        : next;
    if (firstDelivery) await manager.save(DateProjection, date);
    const show =
      date.scheduled === null
        ? null
        : await manager.findOneBy(ShowProjection, { show_id: date.scheduled.show_id });
    return { outcome: firstDelivery ? ('applied' as const) : ('duplicate' as const), date, show };
  });

  const { date } = result;
  if (date !== null && date.scheduled !== null) {
    await indices.dates.put(
      dateDocumentOf({ ...date, scheduled: date.scheduled }, result.show, now),
      Number(date.doc_version),
    );
  }
  return result.outcome;
}
