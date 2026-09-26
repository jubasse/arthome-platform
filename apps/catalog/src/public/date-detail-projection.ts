import type { EntityManager } from 'typeorm';

import type { DateOutcome, PublicationState } from '@arthome/core';

import { DateDetailPublic } from './date-detail-public.entity.js';
import type { Show } from '../catalog/show.entity.js';
import type { PerformanceDate } from '../dates/performance-date.entity.js';
import type { Venue } from '../venues/venue.entity.js';

const APPLIED = { version: () => 'version + 1', applied_at: () => 'now()' };

/** Publishing makes a date public: its row is written whole, once, since publishing is one-way. */
export async function projectPublishedDate(
  manager: EntityManager,
  date: PerformanceDate & { readonly slug_fr: string; readonly slug_en: string },
  show: Show,
  venue: Venue,
  state: PublicationState,
): Promise<void> {
  await manager.insert(DateDetailPublic, {
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
    slug_fr: date.slug_fr,
    slug_en: date.slug_en,
    publication_state: state,
    artist_id: show.artist_id,
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

/** An outcome on a public date; a postponement moves it, so its start moves with it. */
export async function projectOutcome(
  manager: EntityManager,
  dateId: string,
  outcome: DateOutcome,
  rescheduledTo: Date | null,
): Promise<void> {
  await manager.update(
    DateDetailPublic,
    { date_id: dateId },
    {
      outcome,
      rescheduled_to: rescheduledTo,
      ...(rescheduledTo !== null && { starts_at: rescheduledTo }),
      ...APPLIED,
    },
  );
}
