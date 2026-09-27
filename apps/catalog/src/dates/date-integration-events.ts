import { DateOutcomeDeclaredSchema, DateRescheduledSchema } from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EntityManager } from 'typeorm';

import {
  DateOutcomeDeclared,
  type DateRescheduled,
  type PerformanceDateEvent,
} from './performance-date.events.js';
import type { Show } from '../catalog/show.entity.js';
import { writeCatalogEvent, type CatalogEvent } from '../catalog-events.js';
import { dateUrl } from '../public/links.js';
import { venueClockAt } from '../venues/venue-clock.js';
import type { Venue } from '../venues/venue.entity.js';
import { WIRE_DATE_OUTCOME } from '../wire.js';

/** What the wire says beyond the date's own facts: its canonical URL and its venue's clock. */
export interface DateWireContext {
  readonly origin: string;
  readonly show: Pick<Show, 'slug'>;
  readonly venue: Pick<Venue, 'time_zone'>;
  readonly traceparent: string | null;
}

/** One outbox row per event, in the order the aggregate applied them, all keyed by the date. */
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

function integrationEventOf(event: PerformanceDateEvent, context: DateWireContext): CatalogEvent {
  if (event instanceof DateOutcomeDeclared) return outcomeDeclared(event, context);
  return rescheduled(event, context);
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
