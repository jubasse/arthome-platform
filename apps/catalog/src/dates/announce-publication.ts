import {
  DateScheduledSchema,
  PublicationEngagedSchema,
  PublicationEngagement,
} from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EntityManager } from 'typeorm';

import { Locale } from '@arthome/core';

import type { DateRecords } from './date-sheet.js';
import { PerformanceDate } from './performance-date.entity.js';
import { canonicalUrlOf, slugCandidates } from './slug.js';
import { writeCatalogEvent } from '../catalog-events.js';
import { venueClockAt } from '../venues/venue-clock.js';
import { WIRE_BLACKOUT_REASON, WIRE_REPLAY_POLICY, WIRE_RIGHTS_SCOPE } from '../wire.js';

async function freeSlug(
  manager: EntityManager,
  language: Locale,
  candidates: readonly string[],
): Promise<string> {
  for (const candidate of candidates) {
    const where = language === Locale.FR ? { slug_fr: candidate } : { slug_en: candidate };
    if (!(await manager.existsBy(PerformanceDate, where))) return candidate;
  }
  // The last candidate carries the date's own id; the unique index settles a race for it.
  return candidates[candidates.length - 1] ?? '';
}

/**
 * What publishing makes public: the slugs are set and the running time frozen (§2.2, §2.7),
 * then DateScheduled carries the date's public facts and PublicationEngaged what is now
 * committed. Engaged after scheduled, on the same key, so no consumer reads the lock first.
 */
export async function announcePublication(
  manager: EntityManager,
  records: DateRecords,
  origin: string,
  occurredAt: Date,
  traceparent: string | null,
): Promise<void> {
  const { date, show, venue } = records;
  const startsAt = date.starts_at.toISOString();
  const candidates = (language: Locale): string[] =>
    slugCandidates(show.title, language, startsAt, venue.time_zone, date.id);

  const slugs = {
    slug_fr: date.slug_fr ?? (await freeSlug(manager, Locale.FR, candidates(Locale.FR))),
    slug_en: date.slug_en ?? (await freeSlug(manager, Locale.EN, candidates(Locale.EN))),
  };
  await manager.update(
    PerformanceDate,
    { id: date.id },
    { ...slugs, runtime_min: show.runtime_min },
  );

  const venueClock = venueClockAt(venue.time_zone, startsAt);
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
          runtimeMin: show.runtime_min,
          replayPolicy: WIRE_REPLAY_POLICY[date.replay_policy],
          replayWindowHours: date.replay_window_hours ?? 0,
          rights: {
            scope: WIRE_RIGHTS_SCOPE[date.rights.scope],
            blackoutCountries: [...date.rights.blackoutCountries],
            ...(date.rights.reason !== null && {
              reason: WIRE_BLACKOUT_REASON[date.rights.reason],
            }),
          },
          canonicalUrl: canonicalUrlOf(origin, show.title, slugs) ?? '',
          occurredAt: timestampFromDate(occurredAt),
        }),
      ),
      traceparent,
    },
    occurredAt,
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
