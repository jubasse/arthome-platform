import type { DateDocument, IndexedRendition } from '@arthome-platform/search-index';
import type { z } from 'zod';

import type { DateCardSchema, ImageRenditionSchema } from '@arthome/contracts/catalog';
import {
  DomainConstant,
  Locale,
  publicDisplayStateOf,
  replayEndsAt,
  roomOpensAt,
  type DateTiming,
  type Instant,
} from '@arthome/core';

import { canonicalLanguageOf } from '../dates/slug.js';
import { venueClockAt } from '../venues/venue-clock.js';

export type DateCard = z.output<typeof DateCardSchema>;

/** A document `filtersOf` let through: the fields a card requires are present. */
export type ServableDateDocument = DateDocument & {
  readonly publication_state: NonNullable<DateDocument['publication_state']>;
  readonly replay_policy: NonNullable<DateDocument['replay_policy']>;
  readonly rights_scope: NonNullable<DateDocument['rights_scope']>;
};

function renditionOf(rendition: IndexedRendition): z.output<typeof ImageRenditionSchema> {
  return { url: rendition.url, widthPx: rendition.width_px, heightPx: rendition.height_px };
}

/**
 * The public card, anonymous: no per-viewer overlay, and the title, slug and canonical URL in
 *   the title's own language, because this read has no viewer language to choose another.
 * Run state and outcome are passed as unknown: `streaming` does not publish yet, and no command
 *   declares an outcome.
 */
export function dateCardOf(document: ServableDateDocument, now: Instant): DateCard {
  const timing: DateTiming = {
    startsAt: document.starts_at,
    runtimeMin: document.runtime_min,
    roomOpensBeforeMin: DomainConstant.ROOM_OPENS_MINUTES_BEFORE,
    replayPolicy: document.replay_policy,
    replayWindowHours: document.replay_window_hours,
  };
  const display = publicDisplayStateOf({
    publicationState: document.publication_state,
    runState: null,
    outcome: null,
    timing,
    now,
  });
  if (display.validUntil === null) {
    throw new Error(`date ${document.date_id} is ${display.state}, past what search serves`);
  }
  const french =
    canonicalLanguageOf({ fr: document.title_fr, en: document.title_en }) === Locale.FR;
  const venueClock = venueClockAt(document.venue_timezone, document.starts_at);

  return {
    id: document.date_id,
    showId: document.show_id,
    channelId: document.channel_id,
    slug: french ? document.slug_fr : document.slug_en,
    canonicalUrl: document.canonical_url,
    title: french ? document.title_fr : document.title_en,
    ...(document.category_id !== null && { categoryId: document.category_id }),
    genreIds: [...document.genre_ids],
    tagIds: [...document.tag_ids],
    startsAt: document.starts_at,
    venueClock: {
      venueTimezone: venueClock.timeZone,
      venueUtcOffsetMin: venueClock.utcOffsetMinutes,
    },
    runtimeMin: document.runtime_min,
    venue: {
      id: document.venue_id,
      city: document.venue_city,
      countryCode: document.venue_country,
    },
    roomOpensAt: roomOpensAt(timing),
    displayState: display.state,
    displayStateValidUntil: display.validUntil,
    replay: {
      policy: document.replay_policy,
      windowHours: document.replay_window_hours,
      expiresAt: replayEndsAt(timing),
    },
    rights: {
      scope: document.rights_scope,
      blackoutCountries: [...document.blackout_countries],
    },
    media: {
      wide: document.media.wide.map(renditionOf),
      poster: document.media.poster.map(renditionOf),
    },
    ...(document.language_dependency !== null && {
      languageDependency: document.language_dependency,
    }),
  };
}
