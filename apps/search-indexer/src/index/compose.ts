import type { DateDocument, ShowDocument } from '@arthome-platform/search-index';

import { DomainConstant, ReplayPolicy, endsAt, replayEndsAt, type DateTiming } from '@arthome/core';

import type { DateProjection, ScheduledDateFields } from '../consumer/date-projection.entity.js';
import type { ShowProjection } from '../consumer/show-projection.entity.js';

/** The show's document once ShowPublished has landed; an update alone cannot make one. */
export function showDocumentOf(show: ShowProjection, indexedAt: Date): ShowDocument | null {
  const { published, updatable } = show;
  if (published === null || updatable === null) return null;
  return {
    show_id: show.show_id,
    channel_id: published.channel_id,
    artist_id: published.artist_id,
    category_id: published.category_id,
    genre_ids: updatable.genre_ids,
    tag_ids: updatable.tag_ids,
    runtime_min: published.runtime_min,
    language_dependency: updatable.language_dependency,
    spoken_languages: published.spoken_languages,
    subtitle_languages: published.subtitle_languages,
    surtitle_languages: published.surtitle_languages,
    media: updatable.media,
    title_fr: updatable.title.fr,
    title_en: updatable.title.en,
    synopsis_fr: updatable.synopsis.fr,
    synopsis_en: updatable.synopsis.en,
    published_at: published.published_at,
    indexed_at: indexedAt.toISOString(),
  };
}

/**
 * An unknown replay policy reads as none: the date leaves search when its live show ends
 *   rather than lingering for a replay nobody promised.
 */
function timingOf(scheduled: ScheduledDateFields): DateTiming {
  return {
    startsAt: scheduled.starts_at,
    runtimeMin: scheduled.runtime_min,
    roomOpensBeforeMin: DomainConstant.ROOM_OPENS_MINUTES_BEFORE,
    replayPolicy: scheduled.replay_policy ?? ReplayPolicy.NONE,
    replayWindowHours: scheduled.replay_window_hours,
  };
}

export function dateDocumentOf(
  date: DateProjection & { readonly scheduled: ScheduledDateFields },
  show: ShowProjection | null,
  indexedAt: Date,
): DateDocument {
  const { scheduled } = date;
  const updatable = show?.updatable ?? null;
  const timing = timingOf(scheduled);
  const endedAt = endsAt(timing);
  return {
    date_id: date.date_id,
    show_id: scheduled.show_id,
    channel_id: scheduled.channel_id,
    venue_id: scheduled.venue_id,
    starts_at: scheduled.starts_at,
    venue_timezone: scheduled.venue_timezone,
    venue_city: scheduled.venue_city,
    venue_country: scheduled.venue_country,
    runtime_min: scheduled.runtime_min,
    replay_policy: scheduled.replay_policy,
    replay_window_hours: scheduled.replay_window_hours,
    rights_scope: scheduled.rights_scope,
    blackout_countries: scheduled.blackout_countries,
    canonical_url: scheduled.canonical_url,
    slug_fr: scheduled.slug_fr,
    slug_en: scheduled.slug_en,
    publication_state: date.publication_state,
    ends_at: endedAt,
    over_at: replayEndsAt(timing) ?? endedAt,

    artist_id: show?.published?.artist_id ?? null,
    category_id: show?.published?.category_id ?? null,
    genre_ids: updatable?.genre_ids ?? [],
    tag_ids: updatable?.tag_ids ?? [],
    language_dependency: updatable?.language_dependency ?? null,
    title_fr: updatable?.title.fr ?? '',
    title_en: updatable?.title.en ?? '',
    media: updatable?.media ?? { wide: [], poster: [] },

    indexed_at: indexedAt.toISOString(),
  };
}
