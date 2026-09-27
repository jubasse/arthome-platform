import type { z } from 'zod';

import type { ArtistDetailSchema, ArtistSummarySchema } from '@arthome/contracts/catalog';
import { DisplayState, type Instant } from '@arthome/core';

import { dateCardOf, earliestValidUntil, type DateCard } from './date-card.js';
import type { DateDetailPublic } from './date-detail-public.entity.js';
import { publicDateOfRow } from './date-detail.js';
import { biographyLanguageOf } from './links.js';
import type { Artist } from '../artists/artist.entity.js';

export type ArtistSummary = z.output<typeof ArtistSummarySchema>;
export type ArtistDetail = z.output<typeof ArtistDetailSchema>;

/** Each list shows its first twenty; the page links to search for the rest. */
const ARTIST_PAGE_DATES_MAX = 20;

const UPCOMING: ReadonlySet<string> = new Set([
  DisplayState.SCHEDULED,
  DisplayState.ROOM_OPEN,
  DisplayState.LIVE,
  DisplayState.POSTPONED,
]);

export function artistSummaryOf(artist: Artist): ArtistSummary {
  return {
    id: artist.id,
    channelId: artist.channel_id,
    name: artist.public_name,
    slug: artist.slug,
    categoryId: artist.category_id,
  };
}

const byStart = (left: DateCard, right: DateCard): number =>
  Date.parse(left.startsAt) - Date.parse(right.startsAt);
const byExpiry = (left: DateCard, right: DateCard): number =>
  Date.parse(left.displayStateValidUntil ?? left.startsAt) -
  Date.parse(right.displayStateValidUntil ?? right.startsAt);

/**
 * The artist's page from its channel's public dates, split by what each card shows: ahead of the
 *   viewer soonest first, in replay the soonest to expire first, over the latest first.
 */
export function artistPageOf(
  artist: Artist,
  rows: readonly DateDetailPublic[],
  origin: string,
  now: Instant,
): { readonly page: ArtistDetail; readonly validUntil: Instant | null } {
  const cards = rows.map((row) => dateCardOf(publicDateOfRow(row, origin), now));
  const upcomingDates = cards.filter((card) => UPCOMING.has(card.displayState)).sort(byStart);
  const replays = cards.filter((card) => card.displayState === DisplayState.REPLAY).sort(byExpiry);
  const pastDates = cards
    .filter((card) => !UPCOMING.has(card.displayState) && card.displayState !== DisplayState.REPLAY)
    .sort((left, right) => byStart(right, left));
  const language = biographyLanguageOf(artist.biography);
  const biography =
    artist.biography.find((copy) => copy.contentLanguage === language) ?? artist.biography[0];

  const shown = {
    upcomingDates: upcomingDates.slice(0, ARTIST_PAGE_DATES_MAX),
    replays: replays.slice(0, ARTIST_PAGE_DATES_MAX),
    pastDates: pastDates.slice(0, ARTIST_PAGE_DATES_MAX),
  };
  return {
    page: {
      ...artistSummaryOf(artist),
      ...(biography !== undefined && { biography: { ...biography } }),
      joinedAt: artist.joined_at.toISOString(),
      ...shown,
    },
    validUntil: earliestValidUntil([...shown.upcomingDates, ...shown.replays]),
  };
}
