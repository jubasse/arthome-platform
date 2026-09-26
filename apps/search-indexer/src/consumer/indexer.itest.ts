import {
  DateScheduledSchema,
  LanguageDependency as WireLanguageDependency,
  PublicationState as WirePublicationState,
  PublicationStateChangedSchema,
  ReplayPolicy as WireReplayPolicy,
  RightsScope as WireRightsScope,
  ShowPublishedSchema,
  ShowUpdatedSchema,
} from '@arthome-platform/events';
import { ProcessedMessage } from '@arthome-platform/messaging';
import { DATE_INDEX_ALIAS, SHOW_INDEX_ALIAS } from '@arthome-platform/search-index';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { create, toBinary, type DescMessage, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EachMessagePayload } from 'kafkajs';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Locale, PublicationState } from '@arthome/core';

import { applyDateMessage } from './date-consumer.js';
import { DateProjection } from './date-projection.entity.js';
import { applyShowMessage } from './show-consumer.js';
import { ShowProjection } from './show-projection.entity.js';
import {
  createOpenSearchClient,
  ensureIndices,
  indicesOf,
  type Indices,
} from '../index/opensearch-client.js';
import { Initial1758700400000 } from '../migrations/1758700400000-initial.js';
import { ReadModel1790430000000 } from '../migrations/1790430000000-read-model.js';

/**
 * The indexer against a real OpenSearch and a real Postgres. What is proved here and nowhere
 * else: the mappings accept the documents, the external versions refuse what they must, and a
 * date document follows its show whichever of the two arrives first.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

let stack: StartedStack;
let dataSource: DataSource;
let indices: Indices;
let openSearchUrl: string;
let messages = 0;

const nextId = (block: string): string =>
  `01a0e3${block}-0000-7000-8000-${String((messages += 1)).padStart(12, '0')}`;

function message<Desc extends DescMessage>(
  topic: string,
  type: string,
  schema: Desc,
  init: MessageInitShape<Desc>,
  messageId = nextId('ff'),
): EachMessagePayload {
  return {
    topic,
    partition: 0,
    message: {
      key: Buffer.from('key'),
      value: Buffer.from(toBinary(schema, create(schema, init))),
      headers: { 'message-id': Buffer.from(messageId), type: Buffer.from(type) },
    },
  } as unknown as EachMessagePayload;
}

const at = (iso: string) => timestampFromDate(new Date(iso));

function showPublished(
  showId: string,
  occurredAt = '2026-09-25T09:00:00.000Z',
  messageId?: string,
) {
  return message(
    'arthome.catalog.show',
    'catalog.show.published.v1',
    ShowPublishedSchema,
    {
      showId,
      channelId: 'channel-1',
      artistId: 'artist-1',
      categoryId: 'theatre',
      genreIds: ['comedy'],
      runtimeMin: 95,
      languageDependency: WireLanguageDependency.ESSENTIAL,
      spokenLanguages: ['fr-FR'],
      title: [{ contentLanguage: Locale.FR, text: 'Nuit blanche' }],
      synopsis: [{ contentLanguage: Locale.FR, text: 'Une nuit sans sommeil.' }],
      occurredAt: at(occurredAt),
    },
    messageId,
  );
}

function showUpdated(showId: string, genreIds: string[], occurredAt: string) {
  return message('arthome.catalog.show', 'catalog.show.updated.v1', ShowUpdatedSchema, {
    showId,
    genreIds,
    title: [
      { contentLanguage: Locale.FR, text: 'Nuit blanche' },
      { contentLanguage: Locale.EN, text: 'White night' },
    ],
    occurredAt: at(occurredAt),
  });
}

function dateScheduled(dateId: string, showId: string) {
  return message('arthome.catalog.date', 'catalog.date.scheduled.v1', DateScheduledSchema, {
    dateId,
    showId,
    channelId: 'channel-1',
    venueId: 'venue-1',
    startsAt: at('2026-11-04T19:30:00.000Z'),
    venueClock: { venueTimezone: 'Europe/Paris', venueUtcOffsetMin: 60 },
    venueCity: 'Paris',
    venueCountry: 'FR',
    runtimeMin: 95,
    replayPolicy: WireReplayPolicy.INCLUDED,
    replayWindowHours: 72,
    rights: { scope: WireRightsScope.WORLDWIDE },
    canonicalUrl: `https://arthome.test/fr/d/${dateId}`,
    slugFr: `nuit-blanche-${dateId}`,
    slugEn: `white-night-${dateId}`,
    occurredAt: at('2026-09-26T10:00:00.000Z'),
  });
}

function stateChanged(dateId: string, to: WirePublicationState, version: number) {
  return message(
    'arthome.catalog.date',
    'catalog.publication.state_changed.v1',
    PublicationStateChangedSchema,
    { dateId, toState: to, version: BigInt(version), occurredAt: at('2026-09-26T11:00:00.000Z') },
  );
}

async function documentIn(alias: string, id: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${openSearchUrl}/${alias}/_doc/${id}`);
  if (response.status === 404) return null;
  return ((await response.json()) as { _source: Record<string, unknown> })._source;
}

async function hitIds(alias: string, query: object): Promise<string[]> {
  await fetch(`${openSearchUrl}/${alias}/_refresh`, { method: 'POST' });
  const response = await fetch(`${openSearchUrl}/${alias}/_search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = (await response.json()) as { hits: { hits: { _id: string }[] } };
  return body.hits.hits.map((hit) => hit._id);
}

const applyShow = (payload: EachMessagePayload) => applyShowMessage(dataSource, indices, payload);
const applyDate = (payload: EachMessagePayload) => applyDateMessage(dataSource, indices, payload);

beforeAll(async () => {
  stack = await startStack({ postgres: true, opensearch: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'search_itest');
  dataSource = await applyMigrations(database, {
    entities: [ProcessedMessage, ShowProjection, DateProjection],
    migrations: [Initial1758700400000, ReadModel1790430000000],
  });
  openSearchUrl = stack.opensearch.url;
  const client = createOpenSearchClient(openSearchUrl);
  await ensureIndices(client);
  indices = indicesOf(client);
}, STARTUP_MS);

afterAll(async () => {
  await dataSource?.destroy();
  await stack?.stop();
});

describe('the show index', () => {
  it(
    'writes a publication the mapping accepts, lower-casing the language through the normalizer',
    async () => {
      const showId = nextId('a1');
      expect(await applyShow(showPublished(showId))).toBe('applied');

      expect(await documentIn(SHOW_INDEX_ALIAS, showId)).toMatchObject({
        category_id: 'theatre',
        title_fr: 'Nuit blanche',
      });
      expect(await hitIds(SHOW_INDEX_ALIAS, { term: { spoken_languages: 'fr-fr' } })).toContain(
        showId,
      );
    },
    CASE_MS,
  );

  it(
    'rewrites the document on a duplicate, which is what makes a replay a rebuild',
    async () => {
      const showId = nextId('a2');
      const messageId = nextId('ee');
      const first = new Date('2026-09-26T10:00:00.000Z');
      const replay = new Date('2026-09-26T10:05:00.000Z');
      await applyShowMessage(
        dataSource,
        indices,
        showPublished(showId, undefined, messageId),
        first,
      );

      expect(
        await applyShowMessage(
          dataSource,
          indices,
          showPublished(showId, undefined, messageId),
          replay,
        ),
      ).toBe('duplicate');
      expect(await documentIn(SHOW_INDEX_ALIAS, showId)).toMatchObject({
        indexed_at: replay.toISOString(),
      });
    },
    CASE_MS,
  );

  it(
    'refuses an older publication rather than letting a reordered replay undo a newer one',
    async () => {
      const showId = nextId('a3');
      await applyShow(showPublished(showId, '2026-09-25T12:00:00.000Z'));
      expect(await applyShow(showPublished(showId, '2026-09-25T08:00:00.000Z'))).toBe('superseded');
      expect(await documentIn(SHOW_INDEX_ALIAS, showId)).toMatchObject({
        published_at: '2026-09-25T12:00:00.000Z',
      });
    },
    CASE_MS,
  );

  it(
    'replaces what ShowUpdated carries and keeps what only the publication states',
    async () => {
      const showId = nextId('a4');
      await applyShow(showPublished(showId));
      await applyShow(showUpdated(showId, ['drama'], '2026-09-26T09:00:00.000Z'));

      expect(await documentIn(SHOW_INDEX_ALIAS, showId)).toMatchObject({
        genre_ids: ['drama'],
        title_en: 'White night',
        runtime_min: 95,
        published_at: '2026-09-25T09:00:00.000Z',
      });
    },
    CASE_MS,
  );

  it(
    'holds an update that overtook the publication, and keeps it when the publication lands',
    async () => {
      const showId = nextId('a5');
      await applyShow(showUpdated(showId, ['drama'], '2026-09-26T09:00:00.000Z'));
      expect(await documentIn(SHOW_INDEX_ALIAS, showId)).toBeNull();

      await applyShow(showPublished(showId));
      expect(await documentIn(SHOW_INDEX_ALIAS, showId)).toMatchObject({
        category_id: 'theatre',
        genre_ids: ['drama'],
      });
    },
    CASE_MS,
  );
});

describe('the date index', () => {
  it(
    'indexes a scheduled date with its show’s fields, found by a stemmed title',
    async () => {
      const showId = nextId('b1');
      const dateId = nextId('d1');
      await applyShow(showPublished(showId));
      expect(await applyDate(dateScheduled(dateId, showId))).toBe('applied');

      expect(await documentIn(DATE_INDEX_ALIAS, dateId)).toMatchObject({
        show_id: showId,
        category_id: 'theatre',
        title_fr: 'Nuit blanche',
        venue_city: 'Paris',
        venue_country: 'FR',
        publication_state: PublicationState.SCHEDULED,
        starts_at: '2026-11-04T19:30:00.000Z',
        slug_fr: `nuit-blanche-${dateId}`,
        ends_at: '2026-11-04T21:05:00.000Z',
        over_at: '2026-11-07T21:05:00.000Z',
      });
      expect(await hitIds(DATE_INDEX_ALIAS, { match: { title_fr: 'nuits' } })).toContain(dateId);
    },
    CASE_MS,
  );

  it(
    'indexes a date before its show is known, then fills the show in when it lands',
    async () => {
      const showId = nextId('b2');
      const dateId = nextId('d2');
      await applyDate(dateScheduled(dateId, showId));
      expect(await documentIn(DATE_INDEX_ALIAS, dateId)).toMatchObject({
        category_id: null,
        title_fr: '',
      });

      await applyShow(showPublished(showId));
      expect(await documentIn(DATE_INDEX_ALIAS, dateId)).toMatchObject({
        category_id: 'theatre',
        title_fr: 'Nuit blanche',
      });
    },
    CASE_MS,
  );

  it(
    'carries a show update into the show’s public dates',
    async () => {
      const showId = nextId('b3');
      const dateId = nextId('d3');
      await applyShow(showPublished(showId));
      await applyDate(dateScheduled(dateId, showId));
      await applyShow(showUpdated(showId, ['drama'], '2026-09-26T12:00:00.000Z'));

      expect(await documentIn(DATE_INDEX_ALIAS, dateId)).toMatchObject({
        genre_ids: ['drama'],
        title_en: 'White night',
      });
    },
    CASE_MS,
  );

  it(
    'follows the publication state, and keeps a state that overtook DateScheduled',
    async () => {
      const showId = nextId('b4');
      const dateId = nextId('d4');
      await applyShow(showPublished(showId));
      await applyDate(stateChanged(dateId, WirePublicationState.TECHNICAL, 4));
      expect(await documentIn(DATE_INDEX_ALIAS, dateId)).toBeNull();

      await applyDate(dateScheduled(dateId, showId));
      expect(await documentIn(DATE_INDEX_ALIAS, dateId)).toMatchObject({
        publication_state: PublicationState.TECHNICAL,
      });

      await applyDate(stateChanged(dateId, WirePublicationState.SCHEDULED, 5));
      expect(await documentIn(DATE_INDEX_ALIAS, dateId)).toMatchObject({
        publication_state: PublicationState.SCHEDULED,
      });
    },
    CASE_MS,
  );

  it(
    'never indexes a date that was not scheduled',
    async () => {
      const dateId = nextId('d5');
      expect(await applyDate(stateChanged(dateId, WirePublicationState.RESERVE, 2))).toBe(
        'applied',
      );
      expect(await documentIn(DATE_INDEX_ALIAS, dateId)).toBeNull();
    },
    CASE_MS,
  );
});
