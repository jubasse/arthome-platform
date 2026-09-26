import type { z } from 'zod';

import type { DateCardSchema } from '@arthome/contracts/catalog';
import {
  DomainConstant,
  Locale,
  publicDisplayStateOf,
  replayEndsAt,
  roomOpensAt,
  type DateTiming,
  type DateOutcome,
  type Instant,
  type LanguageDependency,
  type MediaSet,
  type PublicationState,
  type ReplayPolicy,
  type RightsScope,
} from '@arthome/core';

import { canonicalLanguageOf } from '../dates/slug.js';
import { venueClockAt } from '../venues/venue-clock.js';

export type DateCard = z.output<typeof DateCardSchema>;

/** A public date, whether read from the search index or from `date_detail_public`. */
export interface PublicDate {
  readonly date_id: string;
  readonly show_id: string;
  readonly channel_id: string;
  readonly venue_id: string;
  /** The search index holds no venue name. */
  readonly venue_name?: string;
  readonly venue_city: string;
  readonly venue_country: string;
  readonly venue_timezone: string;
  readonly starts_at: Instant;
  readonly runtime_min: number;
  readonly replay_policy: ReplayPolicy;
  readonly replay_window_hours: number;
  readonly rights_scope: RightsScope;
  readonly blackout_countries: readonly string[];
  readonly canonical_url: string;
  readonly slug_fr: string;
  readonly slug_en: string;
  readonly publication_state: PublicationState;
  readonly outcome: DateOutcome | null;
  readonly rescheduled_to: Instant | null;
  readonly category_id: string | null;
  readonly genre_ids: readonly string[];
  readonly tag_ids: readonly string[];
  readonly language_dependency: LanguageDependency | null;
  readonly title_fr: string;
  readonly title_en: string;
  readonly media: MediaSet;
}

export function timingOf(date: PublicDate): DateTiming {
  return {
    startsAt: date.starts_at,
    runtimeMin: date.runtime_min,
    roomOpensBeforeMin: DomainConstant.ROOM_OPENS_MINUTES_BEFORE,
    replayPolicy: date.replay_policy,
    replayWindowHours: date.replay_window_hours,
  };
}

/** Whether the title, and so the slug, is served in French: the canonical URL's language. */
export function servedInFrench(date: PublicDate): boolean {
  return canonicalLanguageOf({ fr: date.title_fr, en: date.title_en }) === Locale.FR;
}

/**
 * The public card, anonymous: no per-viewer overlay, and the title, slug and canonical URL in
 *   the title's own language, because a public read has no viewer language to choose another.
 * The run state is passed as unknown: `streaming` does not publish yet.
 */
export function dateCardOf(date: PublicDate, now: Instant): DateCard {
  const timing = timingOf(date);
  const display = publicDisplayStateOf({
    publicationState: date.publication_state,
    runState: null,
    outcome: date.outcome,
    timing,
    now,
  });
  const french = servedInFrench(date);
  const venueClock = venueClockAt(date.venue_timezone, date.starts_at);

  return {
    id: date.date_id,
    showId: date.show_id,
    channelId: date.channel_id,
    slug: french ? date.slug_fr : date.slug_en,
    canonicalUrl: date.canonical_url,
    title: french ? date.title_fr : date.title_en,
    ...(date.category_id !== null && { categoryId: date.category_id }),
    genreIds: [...date.genre_ids],
    tagIds: [...date.tag_ids],
    startsAt: date.starts_at,
    venueClock: {
      venueTimezone: venueClock.timeZone,
      venueUtcOffsetMin: venueClock.utcOffsetMinutes,
    },
    runtimeMin: date.runtime_min,
    venue: {
      id: date.venue_id,
      ...(date.venue_name !== undefined && { name: date.venue_name }),
      city: date.venue_city,
      countryCode: date.venue_country,
    },
    roomOpensAt: roomOpensAt(timing),
    displayState: display.state,
    displayStateValidUntil: display.validUntil,
    ...(date.outcome !== null && { outcome: date.outcome }),
    ...(date.rescheduled_to !== null && { rescheduledTo: date.rescheduled_to }),
    replay: {
      policy: date.replay_policy,
      windowHours: date.replay_window_hours,
      expiresAt: replayEndsAt(timing),
    },
    rights: {
      scope: date.rights_scope,
      blackoutCountries: [...date.blackout_countries],
    },
    media: {
      wide: date.media.wide.map((rendition) => ({ ...rendition })),
      poster: date.media.poster.map((rendition) => ({ ...rendition })),
    },
    ...(date.language_dependency !== null && {
      languageDependency: date.language_dependency,
    }),
  };
}

/** The first instant a card stops being true, `null` when none of them expires. */
export function earliestValidUntil(cards: readonly DateCard[]): Instant | null {
  return cards.reduce<Instant | null>((soonest, card) => {
    const until = card.displayStateValidUntil;
    if (until === null) return soonest;
    return soonest === null || Date.parse(until) < Date.parse(soonest) ? until : soonest;
  }, null);
}
