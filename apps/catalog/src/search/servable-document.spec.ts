import { describe, expect, it } from 'vitest';

import {
  LanguageDependency,
  PublicationState,
  ReplayPolicy,
  ReplayState,
  worldwideRights,
} from '@arthome/core';

import { publicDateOf, type ServableDateDocument } from './servable-document.js';
import type {
  DateProjection,
  ScheduledDateFields,
} from '../../../search-indexer/src/consumer/date-projection.entity.js';
import type { ShowProjection } from '../../../search-indexer/src/consumer/show-projection.entity.js';
import { dateDocumentOf } from '../../../search-indexer/src/index/compose.js';
import { dateCardOf } from '../public/date-card.js';
import type { DateDetailPublic } from '../public/date-detail-public.entity.js';
import { publicDateOfRow } from '../public/date-detail.js';

const ORIGIN = 'https://arthome.test';
const STARTS_AT = '2026-11-04T19:30:00.000Z';
const CLOSES_AT = '2026-11-07T21:20:00.000Z';
const ONLINE_AT = '2026-11-04T22:00:00.000Z';
const LIVE_ENDED_AT = '2026-11-04T21:05:00.000Z';
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

/**
 * The document the indexer writes for the same facts as `source`: the projections the indexer
 * would hold, through its own composition, so a replay field it drops or mis-maps fails here.
 */
function documentOf(source: DateDetailPublic) {
  const startsAt = source.starts_at.toISOString();
  const scheduled: ScheduledDateFields = {
    show_id: source.show_id,
    channel_id: source.channel_id,
    venue_id: source.venue_id,
    venue_timezone: source.venue_timezone,
    venue_city: source.venue_city,
    venue_country: source.venue_country,
    starts_at: startsAt,
    runtime_min: source.runtime_min,
    replay_policy: source.replay_policy,
    replay_window_hours: source.replay_window_hours,
    rights_scope: source.rights.scope,
    blackout_countries: source.rights.blackoutCountries,
    canonical_url: publicDateOfRow(source, ORIGIN).canonical_url,
    show_slug: source.show_slug,
    slug: source.slug,
  };
  const projection: DateProjection = {
    date_id: source.date_id,
    show_id: source.show_id,
    scheduled,
    scheduled_version: '1',
    publication_state: source.publication_state,
    publication_version: null,
    outcome: source.outcome,
    outcome_rescheduled_to: source.rescheduled_to,
    outcome_version: null,
    moved_starts_at: null,
    moved_slug: null,
    moved_canonical_url: null,
    moved_version: null,
    replay_state: source.replay_state,
    replay_live_ended_at: new Date(LIVE_ENDED_AT),
    replay_closes_at: source.replay_closes_at,
    replay_online_at: source.replay_online_at,
    replay_duration_sec: source.replay_duration_sec,
    replay_version: source.replay_state === null ? null : '1',
    doc_version: '1',
    indexed_at: new Date(NOW),
  };
  const show: ShowProjection = {
    show_id: source.show_id,
    version: '1',
    traceparent: null,
    published: {
      channel_id: source.channel_id,
      artist_id: source.artist_id,
      category_id: source.category_id,
      runtime_min: source.runtime_min,
      spoken_languages: source.spoken_languages,
      subtitle_languages: source.subtitle_languages,
      surtitle_languages: source.surtitle_languages,
      published_at: NOW,
    },
    published_version: '1',
    updatable: {
      genre_ids: source.genre_ids,
      tag_ids: source.tag_ids,
      language_dependency: source.language_dependency,
      media: { wide: [], poster: [] },
      title: source.title,
      synopsis: source.synopsis,
    },
    updatable_version: '1',
    indexed_at: new Date(NOW),
  };
  const document = dateDocumentOf(
    { ...projection, scheduled },
    show,
    { artist_id: source.artist_id, public_name: source.artist_name ?? '' },
    new Date(NOW),
  );
  const { publication_state, replay_policy, rights_scope } = document;
  if (publication_state === null || replay_policy === null || rights_scope === null)
    throw new Error('the indexer left a required field of the card empty');
  return { ...document, publication_state, replay_policy, rights_scope };
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
