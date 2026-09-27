import { describe, expect, it } from 'vitest';

import { DateDetailSchema } from '@arthome/contracts/catalog';
import {
  LanguageDependency,
  Locale,
  PublicationState,
  ReplayPolicy,
  worldwideRights,
} from '@arthome/core';

import type { DateDetailPublic } from './date-detail-public.entity.js';
import { dateDetailOf } from './date-detail.js';

const ORIGIN = 'https://arthome.test';
const NOW = '2026-11-10T12:00:00.000Z';
const SHOW = '01a0e600-0000-7000-8000-0000000000a1';

function row(
  dateId: string,
  startsAt: string,
  overrides: Partial<DateDetailPublic> = {},
): DateDetailPublic {
  return {
    date_id: dateId,
    show_id: SHOW,
    channel_id: 'channel-1',
    venue_id: '01a0e600-0000-7000-8000-0000000000c1',
    venue_name: 'Théâtre de la Ville',
    venue_city: 'Paris',
    venue_country: 'FR',
    venue_timezone: 'Europe/Paris',
    starts_at: new Date(startsAt),
    runtime_min: 95,
    replay_policy: ReplayPolicy.NONE,
    replay_window_hours: 0,
    rights: worldwideRights(),
    show_slug: 'nuit-blanche',
    slug: dateId,
    publication_state: PublicationState.SCHEDULED,
    outcome: null,
    rescheduled_to: null,
    artist_id: 'artist-1',
    artist_name: null,
    category_id: 'theatre',
    genre_ids: [],
    tag_ids: [],
    language_dependency: LanguageDependency.NONE,
    spoken_languages: ['fr-FR'],
    subtitle_languages: ['en-GB'],
    surtitle_languages: [],
    media: { wide: [], poster: [] },
    title: { fr: 'Nuit blanche', en: 'White night' },
    synopsis: { fr: '', en: 'A sleepless night.' },
    version: '1',
    applied_at: new Date(NOW),
    ...overrides,
  };
}

/** One date over, the page's own, and two ahead of it in reverse order. */
const ROWS = [
  row('d-over', '2026-11-01T19:30:00.000Z'),
  row('d-page', '2026-11-12T19:30:00.000Z'),
  row('d-later', '2026-11-20T19:30:00.000Z'),
  row('d-sooner', '2026-11-15T19:30:00.000Z'),
];

describe('dateDetailOf', () => {
  it('builds a page the published contract accepts', () => {
    const page = dateDetailOf(ROWS, 'd-page', ORIGIN, NOW);

    expect(DateDetailSchema.safeParse(page?.detail).success).toBe(true);
    expect(page?.detail).toMatchObject({
      canonicalUrl: `${ORIGIN}/show/nuit-blanche/date/d-page`,
      venue: { name: 'Théâtre de la Ville' },
      subtitleLanguages: ['en-GB'],
    });
  });

  it('lists the show’s other dates still ahead, soonest first, and counts them', () => {
    const detail = dateDetailOf(ROWS, 'd-page', ORIGIN, NOW)?.detail;
    const series = detail?.seriesDates as readonly { readonly id: string }[];

    expect(series.map((card) => card.id)).toEqual(['d-sooner', 'd-later']);
    expect(detail?.totalSeriesDates).toBe(2);
  });

  it('serves the synopsis in the other language when the title’s side is empty', () => {
    expect(dateDetailOf(ROWS, 'd-page', ORIGIN, NOW)?.detail.synopsis).toEqual({
      contentLanguage: Locale.EN,
      text: 'A sleepless night.',
    });
  });

  it('serves the page of a date already over, its state held until an event', () => {
    const page = dateDetailOf(ROWS, 'd-over', ORIGIN, NOW);

    expect(page?.detail.displayStateValidUntil).toBeNull();
    // The series still ahead expires first: the page's own card never will.
    expect(page?.validUntil).toBe('2026-11-12T19:00:00.000Z');
  });

  it('knows no page for a date without a public row', () => {
    expect(dateDetailOf(ROWS, 'd-draft', ORIGIN, NOW)).toBeNull();
  });
});
