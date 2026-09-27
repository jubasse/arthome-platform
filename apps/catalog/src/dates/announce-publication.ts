import {
  DateScheduledSchema,
  PublicationEngagedSchema,
  PublicationEngagement,
} from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EntityManager } from 'typeorm';

import type { PublicationState } from '@arthome/core';

import type { DateRecords } from './date-sheet.js';
import { freeDateSlug } from './free-date-slug.js';
import { PerformanceDateRow } from './performance-date.entity.js';
import { writeCatalogEvent } from '../catalog-events.js';
import { projectPublishedDate } from '../public/date-detail-projection.js';
import { dateUrl } from '../public/links.js';
import { venueClockAt } from '../venues/venue-clock.js';
import { WIRE_BLACKOUT_REASON, WIRE_REPLAY_POLICY, WIRE_RIGHTS_SCOPE } from '../wire.js';

/**
 * What publishing makes public: the slug is set and the running time frozen (§2.2, §2.7), the
 * date enters `date_detail_public`, then DateScheduled carries its public facts and
 * PublicationEngaged what is now committed. Engaged after scheduled, on the same key, so no
 * consumer reads the lock first.
 */
export async function announcePublication(
  manager: EntityManager,
  records: DateRecords,
  state: PublicationState,
  origin: string,
  occurredAt: Date,
  traceparent: string | null,
): Promise<void> {
  const { date, show, venue } = records;
  const startsAt = date.starts_at.toISOString();
  const slug =
    date.slug ??
    (await freeDateSlug(manager, date, startsAt, venue.time_zone, occurredAt.toISOString()));
  await manager.update(
    PerformanceDateRow,
    { id: date.id },
    { slug, runtime_min: show.runtime_min },
  );
  await projectPublishedDate(
    manager,
    { ...date, slug, runtime_min: show.runtime_min },
    show,
    venue,
    state,
  );

  await writeDateScheduled(
    manager,
    { ...records, date: { ...date, slug, runtime_min: show.runtime_min } },
    origin,
    occurredAt,
    traceparent,
  );

  await writeCatalogEvent(
    manager,
    {
      type: 'catalog.publication.engaged.v1',
      key: date.id,
      payload: toBinary(
        PublicationEngagedSchema,
        create(PublicationEngagedSchema, {
          dateId: date.id,
          channelId: date.channel_id,
          engaged: [
            PublicationEngagement.PRICES,
            PublicationEngagement.REPLAY,
            PublicationEngagement.CHAT_MODE,
          ],
          occurredAt: timestampFromDate(occurredAt),
        }),
      ),
      traceparent,
    },
    occurredAt,
  );
}

/**
 * The date's public facts as they stand. Publication states them first; a change to how they are
 *   written, such as a new URL form, states them again (`PublicSlugs1790420900000`).
 */
export async function writeDateScheduled(
  manager: EntityManager,
  records: DateRecords & { readonly date: PerformanceDateRow & { readonly slug: string } },
  origin: string,
  occurredAt: Date,
  traceparent: string | null,
): Promise<void> {
  const { date, show, venue } = records;
  const venueClock = venueClockAt(venue.time_zone, date.starts_at.toISOString());
  await writeCatalogEvent(
    manager,
    {
      type: 'catalog.date.scheduled.v1',
      key: date.id,
      payload: toBinary(
        DateScheduledSchema,
        create(DateScheduledSchema, {
          dateId: date.id,
          channelId: date.channel_id,
          showId: date.show_id,
          venueId: date.venue_id,
          startsAt: timestampFromDate(date.starts_at),
          venueClock: {
            venueTimezone: venueClock.timeZone,
            venueUtcOffsetMin: venueClock.utcOffsetMinutes,
          },
          runtimeMin: date.runtime_min,
          replayPolicy: WIRE_REPLAY_POLICY[date.replay_policy],
          replayWindowHours: date.replay_window_hours ?? 0,
          rights: {
            scope: WIRE_RIGHTS_SCOPE[date.rights.scope],
            blackoutCountries: [...date.rights.blackoutCountries],
            ...(date.rights.reason !== null && {
              reason: WIRE_BLACKOUT_REASON[date.rights.reason],
            }),
          },
          canonicalUrl: dateUrl(origin, show.slug, date.slug),
          showSlug: show.slug,
          slug: date.slug,
          venueCity: venue.city,
          venueCountry: venue.country,
          occurredAt: timestampFromDate(occurredAt),
        }),
      ),
      traceparent,
    },
    occurredAt,
  );
}
