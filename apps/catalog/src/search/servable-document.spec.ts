import { describe, expect, it } from 'vitest';

import {
  LanguageDependency,
  PublicationState,
  ReplayPolicy,
  ReplayState,
  worldwideRights,
} from '@arthome/core';

import { dateDocument } from './search-fixtures.js';
import { publicDateOf, type ServableDateDocument } from './servable-document.js';
import { dateCardOf } from '../public/date-card.js';
import type { DateDetailPublic } from '../public/date-detail-public.entity.js';
import { publicDateOfRow } from '../public/date-detail.js';

const ORIGIN = 'https://arthome.test';
const STARTS_AT = '2026-11-04T19:30:00.000Z';
const CLOSES_AT = '2026-11-07T21:20:00.000Z';
const ONLINE_AT = '2026-11-04T22:00:00.000Z';
const NOW = '2026-11-05T12:00:00.000Z';

function row(overrides: Partial<DateDetailPublic> = {}): DateDetailPublic {
  return {
    date_id: '01a0e400-0000-7000-8000-000000000001',
    show_id: '01a0e400-0000-7000-8000-0000000000a1',
    channel_id: 'channel-1',
    venue_id: '01a0e400-0000-7000-8000-0000000000c1',
    venue_name: 'Theatre de la Ville',
    venue_city: 'Paris',
    venue_country: 'FR',
    venue_timezone: 'Europe/Paris',
    starts_at: new Date(STARTS_AT),
    runtime_min: 95,
    replay_policy: ReplayPolicy.INCLUDED,
    replay_window_hours: 72,
    rights: worldwideRights(),
    show_slug: 'nuit-blanche',
    slug: '2026-11-04',
    publication_state: PublicationState.SCHEDULED,
    outcome: null,
    rescheduled_to: null,
    replay_state: null,
    replay_closes_at: null,
    replay_online_at: null,
    replay_duration_sec: null,
    artist_id: '01a0e400-0000-7000-8000-0000000000b1',
    artist_name: 'Compagnie Verticale',
    category_id: 'theatre',
    genre_ids: ['contemporary'],
    tag_ids: [],
    language_dependency: LanguageDependency.NONE,
    spoken_languages: ['fr-FR'],
    subtitle_languages: [],
    surtitle_languages: [],
    media: { wide: [], poster: [] },
    title: { fr: 'Nuit blanche', en: 'White night' },
    synopsis: { fr: '', en: '' },
    version: '1',
    applied_at: new Date(NOW),
    ...overrides,
  };
}

/** The document the indexer writes for the same facts as `source`, and no more than it holds. */
function documentOf(source: DateDetailPublic) {
  const date = publicDateOfRow(source, ORIGIN);
  return dateDocument({
    date_id: date.date_id,
    show_id: date.show_id,
    channel_id: date.channel_id,
    venue_id: date.venue_id,
    venue_city: date.venue_city,
    venue_country: date.venue_country,
    venue_timezone: date.venue_timezone,
    starts_at: date.starts_at,
    runtime_min: date.runtime_min,
    replay_policy: date.replay_policy,
    replay_window_hours: date.replay_window_hours,
    rights_scope: date.rights_scope,
    blackout_countries: [...date.blackout_countries],
    canonical_url: date.canonical_url,
    show_slug: date.show_slug,
    slug: date.slug,
    publication_state: date.publication_state,
    artist_id: date.artist_id,
    artist_name: date.artist_name,
    category_id: date.category_id,
    genre_ids: [...date.genre_ids],
    tag_ids: [...date.tag_ids],
    language_dependency: date.language_dependency,
    title_fr: date.title_fr,
    title_en: date.title_en,
    media: { wide: [], poster: [] },
    replay_state: date.replay_state ?? null,
    replay_closes_at: date.replay_closes_at ?? null,
    replay_online_at: date.replay_online_at ?? null,
    replay_duration_sec: date.replay_duration_sec ?? null,
  });
}

/** The index holds no venue name: the cards differ by that one field and no other. */
function withoutVenueName(card: ReturnType<typeof dateCardOf>) {
  const { name: _name, ...venue } = card.venue ?? {};
  return { ...card, venue };
}

describe('the card from the index and the card from date_detail_public', () => {
  const ended = {
    publication_state: PublicationState.ENDED,
    replay_closes_at: new Date(CLOSES_AT),
  };
  const cases = [
    ['no replay yet', row()],
    ['a pending replay', row({ ...ended, replay_state: ReplayState.PENDING })],
    [
      'an online replay',
      row({
        ...ended,
        replay_state: ReplayState.ONLINE,
        replay_online_at: new Date(ONLINE_AT),
        replay_duration_sec: 5400,
      }),
    ],
    ['a withdrawn replay', row({ ...ended, replay_state: ReplayState.WITHDRAWN })],
  ] as const;

  it.each(cases)('are equal for %s', (_name, source) => {
    const fromRow = dateCardOf(publicDateOfRow(source, ORIGIN), NOW);
    const fromIndex = dateCardOf(publicDateOf(documentOf(source)), NOW);

    expect(fromIndex).toEqual(withoutVenueName(fromRow));
  });

  it('gives a document indexed before the replay fields a card without a replay facet', () => {
    // a document written before the release: the type requires the fields, the stored JSON lacks them
    const {
      replay_state: _state,
      replay_closes_at: _closesAt,
      replay_online_at: _onlineAt,
      replay_duration_sec: _durationSec,
      ...legacy
    } = documentOf(row());

    const fromIndex = dateCardOf(publicDateOf(legacy as ServableDateDocument), NOW);
    const fromRow = dateCardOf(publicDateOfRow(row(), ORIGIN), NOW);

    expect(fromIndex).toEqual(withoutVenueName(fromRow));
  });
});
