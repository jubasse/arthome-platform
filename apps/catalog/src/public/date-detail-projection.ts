import type { EntityManager } from 'typeorm';

import type { DateOutcome, PublicationState } from '@arthome/core';

import { DateDetailPublic } from './date-detail-public.entity.js';
import { Artist } from '../artists/artist.entity.js';
import type { Show } from '../catalog/show.entity.js';
import type { PerformanceDate } from '../dates/performance-date.entity.js';
import type { Venue } from '../venues/venue.entity.js';

const APPLIED = { version: () => 'version + 1', applied_at: () => 'now()' };

/** Publishing makes a date public: its row is written whole, once, since publishing is one-way. */
export async function projectPublishedDate(
  manager: EntityManager,
  date: PerformanceDate & { readonly slug: string },
  show: Show,
  venue: Venue,
  state: PublicationState,
): Promise<void> {
  const artist = await manager.findOneBy(Artist, { channel_id: date.channel_id });
  await manager.insert(DateDetailPublic, {
    artist_name: artist?.public_name ?? null,
    date_id: date.id,
    show_id: date.show_id,
    channel_id: date.channel_id,
    venue_id: venue.id,
    venue_name: venue.name,
    venue_city: venue.city,
    venue_country: venue.country,
    venue_timezone: venue.time_zone,
    starts_at: date.starts_at,
    runtime_min: date.runtime_min,
    replay_policy: date.replay_policy,
    replay_window_hours: date.replay_window_hours ?? 0,
    rights: date.rights,
    show_slug: show.slug,
    slug: date.slug,
    publication_state: state,
    // The channel's face when it has one, else what the show named: one artist per channel.
    artist_id: artist?.id ?? show.artist_id,
    category_id: show.category_id,
    genre_ids: show.genre_ids,
    tag_ids: show.tag_ids,
    language_dependency: show.language_dependency,
    spoken_languages: show.spoken_languages,
    subtitle_languages: show.subtitle_languages,
    surtitle_languages: show.surtitle_languages,
    media: show.media,
    title: show.title,
    synopsis: show.synopsis,
  });
}

/** A date not public yet has no row, and its transitions match none. */
export async function projectPublicationState(
  manager: EntityManager,
  dateId: string,
  state: PublicationState,
): Promise<void> {
  await manager.update(
    DateDetailPublic,
    { date_id: dateId },
    { publication_state: state, ...APPLIED },
  );
}

/** A show's copy, on every public date of it. */
export async function projectShowCopy(
  manager: EntityManager,
  show: Pick<
    Show,
    'id' | 'genre_ids' | 'tag_ids' | 'language_dependency' | 'media' | 'title' | 'synopsis'
  >,
): Promise<void> {
  await manager.update(
    DateDetailPublic,
    { show_id: show.id },
    {
      genre_ids: show.genre_ids,
      tag_ids: show.tag_ids,
      language_dependency: show.language_dependency,
      media: show.media,
      title: show.title,
      synopsis: show.synopsis,
      ...APPLIED,
    },
  );
}

/** An outcome on a public date; a postponement moves it, its start and its slug with it. */
export async function projectOutcome(
  manager: EntityManager,
  dateId: string,
  outcome: DateOutcome,
  moved: { readonly startsAt: Date; readonly slug: string } | null,
): Promise<void> {
  await manager.update(
    DateDetailPublic,
    { date_id: dateId },
    {
      outcome,
      // "rescheduled_to exists only if outcome = 'postponed'" (§2.2): a cancellation clears it.
      rescheduled_to: moved?.startsAt ?? null,
      ...(moved !== null && { starts_at: moved.startsAt, slug: moved.slug }),
      ...APPLIED,
    },
  );
}

/** The channel's public face, on every public date of the channel. */
export async function projectArtist(
  manager: EntityManager,
  artist: Pick<Artist, 'id' | 'channel_id' | 'public_name'>,
): Promise<void> {
  await manager.update(
    DateDetailPublic,
    { channel_id: artist.channel_id },
    { artist_id: artist.id, artist_name: artist.public_name, ...APPLIED },
  );
}
