import type { z } from 'zod';

import type { DateCardSchema } from '@arthome/contracts/catalog';
import {
  DomainConstant,
  Locale,
  PublicationState,
  ReplayState,
  RunState,
  publicDisplayStateOf,
  roomOpensAt,
  type DateTiming,
  type DateOutcome,
  type Instant,
  type LanguageDependency,
  type MediaSet,
  type ReplayDisplayInput,
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
  /** Named on the card once the channel has a public face (`updateChannelIdentity`). */
  readonly artist_id: string | null;
  readonly artist_name: string | null;
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
  readonly show_slug: string;
  readonly slug: string;
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
  /**
   * The date's `Replay` as its last `catalog.replay.state_changed.v1` carried it, absent or null
   *   before its live ended. Optional, so the search index's document fills them under these names.
   */
  readonly replay_state?: ReplayState | null;
  readonly replay_closes_at?: Instant | null;
  readonly replay_online_at?: Instant | null;
  readonly replay_duration_sec?: number | null;
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

/** Whether the title is served in French; a URL carries no language (D-075). */
export function servedInFrench(date: PublicDate): boolean {
  return canonicalLanguageOf({ fr: date.title_fr, en: date.title_en }) === Locale.FR;
}

/**
 * Catalog learns the run only through `run.started` and `run.ended`, and its publication records
 *   exactly them: a published date is idle until the start arrives. Draft and reserve say nothing.
 */
export function runStateKnownFrom(publicationState: PublicationState): RunState | null {
  switch (publicationState) {
    case PublicationState.SCHEDULED:
    case PublicationState.TECHNICAL:
      return RunState.IDLE;
    case PublicationState.LIVE:
      return RunState.ON_AIR;
    case PublicationState.ENDED:
    case PublicationState.REPLAY_ONLINE:
      return RunState.ENDED;
    case PublicationState.DRAFT:
    case PublicationState.RESERVE:
      return null;
  }
}

function replayDisplayOf(date: PublicDate): ReplayDisplayInput | null {
  const state = date.replay_state ?? null;
  const closesAt = date.replay_closes_at ?? null;
  return state === null || closesAt === null ? null : { state, closesAt };
}

const SHOWS_ITS_WINDOW: ReadonlySet<ReplayState> = new Set([
  ReplayState.ONLINE,
  ReplayState.CLOSED,
]);

/** The `Replay`'s facts, never the scheduled timing's: a window shows once it was online or closed. */
function replayOf(date: PublicDate) {
  const promise = { policy: date.replay_policy, windowHours: date.replay_window_hours };
  const state = date.replay_state ?? null;
  if (state === null || !SHOWS_ITS_WINDOW.has(state)) return promise;
  const onlineAt = date.replay_online_at ?? null;
  const closesAt = date.replay_closes_at ?? null;
  const durationSec = date.replay_duration_sec ?? null;
  return {
    ...promise,
    ...(onlineAt !== null && { availableFrom: onlineAt }),
    ...(closesAt !== null && { expiresAt: closesAt }),
    ...(durationSec !== null && { durationSec }),
  };
}

/**
 * The public card, anonymous: no per-viewer overlay, and the title in its own language, because a
 *   public read has no viewer language to choose another.
 */
export function dateCardOf(date: PublicDate, now: Instant): DateCard {
  const timing = timingOf(date);
  const replay = replayDisplayOf(date);
  const display = publicDisplayStateOf({
    publicationState: date.publication_state,
    runState: runStateKnownFrom(date.publication_state),
    outcome: date.outcome,
    timing,
    now,
    ...(replay !== null && { replay }),
  });
  const french = servedInFrench(date);
  const venueClock = venueClockAt(date.venue_timezone, date.starts_at);

  return {
    id: date.date_id,
    showId: date.show_id,
    channelId: date.channel_id,
    ...(date.artist_id !== null &&
      date.artist_name !== null && { artist: { id: date.artist_id, name: date.artist_name } }),
    slug: date.slug,
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
    replay: replayOf(date),
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
