import type { EntityManager } from 'typeorm';

import { DateDetailPublic } from './date-detail-public.entity.js';
import { Artist } from '../artists/artist.entity.js';
import { assertNever } from '../assert-never.js';
import type { Show } from '../catalog/show.entity.js';
import type { PerformanceDateSnapshot } from '../dates/performance-date.aggregate.js';
import { DateScheduled, type PerformanceDateEvent } from '../dates/performance-date.events.js';
import type { Venue } from '../venues/venue.entity.js';

const APPLIED = { version: () => 'version + 1', applied_at: () => 'now()' };

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

type DateChanges = Partial<
  Pick<DateDetailPublic, 'outcome' | 'rescheduled_to' | 'starts_at' | 'slug' | 'publication_state'>
>;

/** What a date's row copies from its show and its venue. */
export interface DateCopies {
  readonly show: Show;
  readonly venue: Venue;
}

/**
 * One command's events as one write, since the row's version counts commands: the whole row when
 *   the date goes public, its changes otherwise. A date not public yet has no row to change.
 */
export async function projectDateEvents(
  manager: EntityManager,
  events: readonly PerformanceDateEvent[],
  copies: DateCopies,
): Promise<void> {
  const changes = events.reduce<DateChanges>(
    (merged, event) => ({ ...merged, ...changesOf(event) }),
    {},
  );
  const scheduled = events.find((event) => event instanceof DateScheduled);
  if (scheduled !== undefined) {
    await insertPublicDate(manager, scheduled.date, copies, changes);
    return;
  }
  const [first] = events;
  if (first === undefined || Object.keys(changes).length === 0) return;
  await manager.update(DateDetailPublic, { date_id: first.dateId }, { ...changes, ...APPLIED });
}

function changesOf(event: PerformanceDateEvent): DateChanges {
  switch (event.kind) {
    case 'PublicationStateChanged':
      return { publication_state: event.to };
    case 'DateOutcomeDeclared':
      return {
        outcome: event.outcome,
        // "rescheduled_to exists only if outcome = 'postponed'" (§2.2): a cancellation clears it.
        rescheduled_to: event.rescheduledTo === null ? null : new Date(event.rescheduledTo),
      };
    case 'DateRescheduled':
      return { starts_at: new Date(event.newStartsAt), slug: event.newSlug };
    // A draft has no public row, `DateScheduled` writes it whole, and the lock shows on no page.
    case 'DateDrafted':
    case 'DateScheduled':
    case 'PublicationEngaged':
      return {};
    default:
      return assertNever(event);
  }
}

/** Publishing is one-way, so the row is written whole once, with the state it published in. */
async function insertPublicDate(
  manager: EntityManager,
  date: PerformanceDateSnapshot & { readonly slug: string },
  { show, venue }: DateCopies,
  changes: DateChanges,
): Promise<void> {
  // Shared lock to the commit: a rename committing meanwhile could not reach this row.
  const artist = await manager.findOne(Artist, {
    where: { channel_id: date.channelId },
    lock: { mode: 'pessimistic_read' },
  });
  await manager.insert(DateDetailPublic, {
    artist_name: artist?.public_name ?? null,
    date_id: date.id,
    show_id: date.showId,
    channel_id: date.channelId,
    venue_id: venue.id,
    venue_name: venue.name,
    venue_city: venue.city,
    venue_country: venue.country,
    venue_timezone: venue.time_zone,
    starts_at: new Date(date.startsAt),
    runtime_min: date.runtimeMin,
    replay_policy: date.replayPolicy,
    replay_window_hours: date.replayWindowHours ?? 0,
    rights: date.rights,
    show_slug: show.slug,
    slug: date.slug,
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
    ...changes,
  });
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
