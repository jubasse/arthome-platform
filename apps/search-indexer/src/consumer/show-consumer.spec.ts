import {
  LanguageDependency as WireLanguageDependency,
  ShowPublishedSchema,
  ShowUpdatedSchema,
} from '@arthome-platform/events';
import { PermanentError } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EachMessagePayload } from 'kafkajs';
import type { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { LanguageDependency, Locale } from '@arthome/core';

import { applyShowMessage, showAfter, showFactOf, type ShowFact } from './show-consumer.js';
import type { ShowProjection } from './show-projection.entity.js';
import type { Indices } from '../index/opensearch-client.js';

const SHOW_ID = '01a0d537-0abe-71f1-9ee1-d89eee348187';
const PUBLISHED_AT = new Date('2026-09-25T09:00:00.000Z');
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

function published(
  occurredAt: Date | null = PUBLISHED_AT,
  languageDependency = WireLanguageDependency.ESSENTIAL,
): Uint8Array {
  return toBinary(
    ShowPublishedSchema,
    create(ShowPublishedSchema, {
      showId: SHOW_ID,
      channelId: 'channel-1',
      artistId: 'artist-1',
      categoryId: 'theatre',
      genreIds: ['comedy'],
      runtimeMin: 95,
      languageDependency,
      spokenLanguages: ['fr-FR'],
      title: [{ contentLanguage: Locale.FR, text: 'Nuit blanche' }],
      ...(occurredAt === null ? {} : { occurredAt: timestampFromDate(occurredAt) }),
    }),
  );
}

function updated(occurredAt: Date, genreIds: string[]): Uint8Array {
  return toBinary(
    ShowUpdatedSchema,
    create(ShowUpdatedSchema, {
      showId: SHOW_ID,
      genreIds,
      title: [
        { contentLanguage: Locale.FR, text: 'Nuit blanche' },
        { contentLanguage: Locale.EN, text: 'White night' },
      ],
      occurredAt: timestampFromDate(occurredAt),
    }),
  );
}

function emptyRow(): ShowProjection {
  return {
    show_id: SHOW_ID,
    version: '0',
    traceparent: null,
    published: null,
    published_version: null,
    updatable: null,
    updatable_version: null,
    indexed_at: new Date(),
  };
}

const at = (iso: string): number => new Date(iso).getTime();

describe('showFactOf', () => {
  it('reads a publication as both groups, versioned by when it happened', () => {
    const fact = showFactOf('catalog.show.published.v1', published());
    expect(fact.version).toBe(PUBLISHED_AT.getTime());
    expect(fact.published).toMatchObject({ category_id: 'theatre', runtime_min: 95 });
    expect(fact.updatable.title).toEqual({ fr: 'Nuit blanche', en: '' });
  });

  it('reads an update as the updatable group alone', () => {
    const fact = showFactOf(
      'catalog.show.updated.v1',
      updated(new Date('2026-09-26T09:00:00.000Z'), ['drama']),
    );
    expect(fact.published).toBeNull();
    expect(fact.updatable).toMatchObject({
      genre_ids: ['drama'],
      title: { fr: 'Nuit blanche', en: 'White night' },
    });
  });

  it('reads an unspecified or unknown language dependency as absent, never as a member', () => {
    const unspecified = showFactOf(
      'catalog.show.published.v1',
      published(PUBLISHED_AT, WireLanguageDependency.UNSPECIFIED),
    );
    const unknown = showFactOf(
      'catalog.show.published.v1',
      published(PUBLISHED_AT, 99 as WireLanguageDependency),
    );
    expect(unspecified.updatable.language_dependency).toBeNull();
    expect(unknown.updatable.language_dependency).toBeNull();
    expect(showFactOf('catalog.show.published.v1', published()).updatable.language_dependency).toBe(
      LanguageDependency.ESSENTIAL,
    );
  });
});

describe('showAfter', () => {
  const publication = showFactOf('catalog.show.published.v1', published());
  const laterUpdate: ShowFact = showFactOf(
    'catalog.show.updated.v1',
    updated(new Date('2026-09-26T09:00:00.000Z'), ['drama']),
  );

  it('takes both groups of a first publication', () => {
    const next = showAfter(emptyRow(), publication, TRACEPARENT);
    expect(next?.published_version).toBe(String(publication.version));
    expect(next?.updatable?.genre_ids).toEqual(['comedy']);
    expect(next?.traceparent).toBe(TRACEPARENT);
  });

  it('keeps an update that overtook the publication when the publication lands', () => {
    const afterUpdate = showAfter(emptyRow(), laterUpdate, null);
    if (afterUpdate === null) throw new Error('the update should apply');
    const next = showAfter(afterUpdate, publication, null);
    expect(next?.published?.category_id).toBe('theatre');
    expect(next?.updatable?.genre_ids).toEqual(['drama']);
    expect(next?.version).toBe(String(at('2026-09-26T09:00:00.000Z')));
  });

  it('refuses an update older than the fields it would replace', () => {
    const current = showAfter(emptyRow(), laterUpdate, null);
    if (current === null) throw new Error('the update should apply');
    const older = showFactOf(
      'catalog.show.updated.v1',
      updated(new Date('2026-09-25T12:00:00.000Z'), ['comedy']),
    );
    expect(showAfter(current, older, null)).toBeNull();
  });
});

describe('applyShowMessage, before any write', () => {
  const noDatabase = {
    transaction: () => {
      throw new Error('no transaction expected');
    },
  } as unknown as DataSource;
  const noWrite = (): Promise<never> => Promise.reject(new Error('no index write expected'));
  const noIndex: Indices = { shows: { put: noWrite }, dates: { put: noWrite } };

  function message(headers: Record<string, string>, value: Uint8Array | null): EachMessagePayload {
    return {
      topic: 'arthome.catalog.show',
      partition: 0,
      message: {
        key: Buffer.from(SHOW_ID),
        value: value === null ? null : Buffer.from(value),
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Buffer.from(v)])),
      },
    } as unknown as EachMessagePayload;
  }

  const headers = { 'message-id': 'm-1', type: 'catalog.show.published.v1' };

  it('ignores a type it does not handle', async () => {
    await expect(
      applyShowMessage(noDatabase, noIndex, message({ ...headers, type: 'x.v1' }, null)),
    ).resolves.toBe('ignored');
  });

  it.each([
    ['no message-id', message({ type: headers.type }, published())],
    ['no value', message(headers, null)],
    ['bytes that are not this schema', message(headers, new Uint8Array([0xff, 0xff, 0xff]))],
    ['a publication with no occurred_at', message(headers, published(null))],
  ])('refuses %s as permanent', async (_, payload) => {
    await expect(applyShowMessage(noDatabase, noIndex, payload)).rejects.toThrow(PermanentError);
  });
});
