import {
  DateDraftedSchema,
  DateOutcomeDeclaredSchema,
  DateRescheduledSchema,
  DateScheduledSchema,
  PublicationEngagedSchema,
  PublicationEngagement,
  PublicationStateChangedSchema,
} from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EntityManager } from 'typeorm';

import type { DateRecords } from './date-sheet.js';
import type { PerformanceDateSnapshot } from './performance-date.aggregate.js';
import {
  DateDrafted,
  DateOutcomeDeclared,
  DateRescheduled,
  DateScheduled,
  PublicationStateChanged,
  type PerformanceDateEvent,
  type PublicationEngaged,
} from './performance-date.events.js';
import type { Show } from '../catalog/show.entity.js';
import { writeCatalogEvent, type CatalogEvent } from '../catalog-events.js';
import { dateUrl } from '../public/links.js';
import { venueClockAt } from '../venues/venue-clock.js';
import type { Venue } from '../venues/venue.entity.js';
import {
  WIRE_BLACKOUT_REASON,
  WIRE_DATE_OUTCOME,
  WIRE_PUBLICATION_STATE,
  WIRE_REPLAY_POLICY,
  WIRE_RIGHTS_SCOPE,
} from '../wire.js';

/** What the wire says beyond the date's own facts: its canonical URL and its venue's clock. */
export interface DateWireContext {
  readonly origin: string;
  readonly show: Pick<Show, 'slug'>;
  readonly venue: Venue;
  readonly traceparent: string | null;
}

/** One outbox row per event, all keyed by the date, in the order the aggregate applied them. */
export async function writeDateIntegrationEvents(
  manager: EntityManager,
  events: readonly PerformanceDateEvent[],
  context: DateWireContext,
): Promise<void> {
  for (const event of events) {
    await writeCatalogEvent(
      manager,
      integrationEventOf(event, context),
      new Date(event.occurredAt),
    );
  }
}

/**
 * The date's public facts as they stand. Publication states them first; a change to how they are
 *   written, such as a new URL form, states them again (`PublicSlugs1790420900000`).
 */
export async function writeDateScheduled(
  manager: EntityManager,
  records: DateRecords & { readonly date: PerformanceDateSnapshot & { readonly slug: string } },
  origin: string,
  occurredAt: Date,
  traceparent: string | null,
): Promise<void> {
  const { date, show, venue } = records;
  await writeDateIntegrationEvents(manager, [new DateScheduled(date, occurredAt.toISOString())], {
    origin,
    show,
    venue,
    traceparent,
  });
}

function integrationEventOf(event: PerformanceDateEvent, context: DateWireContext): CatalogEvent {
  if (event instanceof DateDrafted) return drafted(event, context);
  if (event instanceof DateScheduled) return scheduled(event, context);
  if (event instanceof DateOutcomeDeclared) return outcomeDeclared(event, context);
  if (event instanceof DateRescheduled) return rescheduled(event, context);
  if (event instanceof PublicationStateChanged) return stateChanged(event, context);
  return engaged(event, context);
}

function drafted(event: DateDrafted, context: DateWireContext): CatalogEvent {
  return {
    type: 'catalog.date.drafted.v1',
    key: event.dateId,
    payload: toBinary(
      DateDraftedSchema,
      create(DateDraftedSchema, {
        dateId: event.dateId,
        channelId: event.channelId,
        showId: event.showId,
        venueId: event.venueId,
        occurredAt: timestampFromDate(new Date(event.occurredAt)),
      }),
    ),
    traceparent: context.traceparent,
  };
}

function scheduled({ date, occurredAt }: DateScheduled, context: DateWireContext): CatalogEvent {
  const { show, venue } = context;
  const venueClock = venueClockAt(venue.time_zone, date.startsAt);
  return {
    type: 'catalog.date.scheduled.v1',
    key: date.id,
    payload: toBinary(
      DateScheduledSchema,
      create(DateScheduledSchema, {
        dateId: date.id,
        channelId: date.channelId,
        showId: date.showId,
        venueId: date.venueId,
        startsAt: timestampFromDate(new Date(date.startsAt)),
        venueClock: {
          venueTimezone: venueClock.timeZone,
          venueUtcOffsetMin: venueClock.utcOffsetMinutes,
        },
        runtimeMin: date.runtimeMin,
        replayPolicy: WIRE_REPLAY_POLICY[date.replayPolicy],
        replayWindowHours: date.replayWindowHours ?? 0,
        rights: {
          scope: WIRE_RIGHTS_SCOPE[date.rights.scope],
          blackoutCountries: [...date.rights.blackoutCountries],
          ...(date.rights.reason !== null && {
            reason: WIRE_BLACKOUT_REASON[date.rights.reason],
          }),
        },
        canonicalUrl: dateUrl(context.origin, show.slug, date.slug),
        showSlug: show.slug,
        slug: date.slug,
        venueCity: venue.city,
        venueCountry: venue.country,
        occurredAt: timestampFromDate(new Date(occurredAt)),
      }),
    ),
    traceparent: context.traceparent,
  };
}

function outcomeDeclared(event: DateOutcomeDeclared, context: DateWireContext): CatalogEvent {
  return {
    type: 'catalog.date.outcome_declared.v1',
    key: event.dateId,
    payload: toBinary(
      DateOutcomeDeclaredSchema,
      create(DateOutcomeDeclaredSchema, {
        dateId: event.dateId,
        channelId: event.channelId,
        outcome: WIRE_DATE_OUTCOME[event.outcome],
        message: event.message,
        ...(event.rescheduledTo !== null && {
          rescheduledTo: timestampFromDate(new Date(event.rescheduledTo)),
        }),
        declaredAt: timestampFromDate(new Date(event.occurredAt)),
      }),
    ),
    traceparent: context.traceparent,
  };
}

function rescheduled(event: DateRescheduled, context: DateWireContext): CatalogEvent {
  const venueClock = venueClockAt(context.venue.time_zone, event.newStartsAt);
  return {
    type: 'catalog.date.rescheduled.v1',
    key: event.dateId,
    payload: toBinary(
      DateRescheduledSchema,
      create(DateRescheduledSchema, {
        dateId: event.dateId,
        previousStartsAt: timestampFromDate(new Date(event.previousStartsAt)),
        newStartsAt: timestampFromDate(new Date(event.newStartsAt)),
        newVenueClock: {
          venueTimezone: venueClock.timeZone,
          venueUtcOffsetMin: venueClock.utcOffsetMinutes,
        },
        newSlug: event.newSlug,
        newCanonicalUrl: dateUrl(context.origin, context.show.slug, event.newSlug),
        occurredAt: timestampFromDate(new Date(event.occurredAt)),
      }),
    ),
    traceparent: context.traceparent,
  };
}

function stateChanged(event: PublicationStateChanged, context: DateWireContext): CatalogEvent {
  return {
    type: 'catalog.publication.state_changed.v1',
    key: event.dateId,
    payload: toBinary(
      PublicationStateChangedSchema,
      create(PublicationStateChangedSchema, {
        dateId: event.dateId,
        channelId: event.channelId,
        fromState: WIRE_PUBLICATION_STATE[event.from],
        toState: WIRE_PUBLICATION_STATE[event.to],
        version: BigInt(event.version),
        irreversible: event.irreversible,
        occurredAt: timestampFromDate(new Date(event.occurredAt)),
      }),
    ),
    traceparent: context.traceparent,
  };
}

function engaged(event: PublicationEngaged, context: DateWireContext): CatalogEvent {
  return {
    type: 'catalog.publication.engaged.v1',
    key: event.dateId,
    payload: toBinary(
      PublicationEngagedSchema,
      create(PublicationEngagedSchema, {
        dateId: event.dateId,
        channelId: event.channelId,
        engaged: [
          PublicationEngagement.PRICES,
          PublicationEngagement.REPLAY,
          PublicationEngagement.CHAT_MODE,
        ],
        occurredAt: timestampFromDate(new Date(event.occurredAt)),
      }),
    ),
    traceparent: context.traceparent,
  };
}
