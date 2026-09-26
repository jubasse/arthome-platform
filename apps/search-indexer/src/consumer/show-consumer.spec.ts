import {
  LanguageDependency as WireLanguageDependency,
  ShowPublishedSchema,
} from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EachMessagePayload } from 'kafkajs';
import type { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { LanguageDependency } from '@arthome/core';

import { applyMessage } from './show-consumer.js';
import type { IndexWrite, ShowIndex } from '../index/opensearch-client.js';
import type { ShowDocument } from '../index/show-document.js';

const SHOW_ID = '01a0d537-0abe-71f1-9ee1-d89eee348187';
const MESSAGE_ID = '01a0d537-0abe-71f1-9ee1-de46f259a23e';
const OCCURRED_AT = new Date('2026-09-25T09:00:00.000Z');
const INDEXED_AT = new Date('2026-09-25T09:00:01.000Z');
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

interface ShowFields {
  readonly languageDependency?: WireLanguageDependency;
  readonly occurredAt?: Date | undefined;
}

function value(fields: ShowFields = {}): Buffer {
  const occurredAt = 'occurredAt' in fields ? fields.occurredAt : OCCURRED_AT;
  return Buffer.from(
    toBinary(
      ShowPublishedSchema,
      create(ShowPublishedSchema, {
        showId: SHOW_ID,
        channelId: '01a0d537-0abe-71f1-9ee1-000000000001',
        artistId: '01a0d537-0abe-71f1-9ee1-000000000002',
        categoryId: 'theatre',
        genreIds: ['comedy'],
        tagIds: ['family'],
        runtimeMin: 95,
        languageDependency: fields.languageDependency ?? WireLanguageDependency.ESSENTIAL,
        // Authored in mixed case on purpose: BCP 47 is case-insensitive, and
        // the document keeps what was authored — the INDEX lower-cases it, via
        // the normalizer declared in the mapping.
        spokenLanguages: ['fr-FR'],
        subtitleLanguages: ['en-GB'],
        surtitleLanguages: [],
        media: {
          wide: [{ url: 'https://cdn.example.test/w.jpg', widthPx: 1280, heightPx: 720 }],
          poster: [],
        },
        ...(occurredAt === undefined ? {} : { occurredAt: timestampFromDate(occurredAt) }),
      }),
    ),
  );
}

function message(
  headers: Record<string, string>,
  body: Buffer | null = value(),
): EachMessagePayload {
  return {
    topic: 'arthome.catalog.show',
    partition: 0,
    message: {
      key: Buffer.from(SHOW_ID),
      value: body,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Buffer.from(v)])),
    },
  } as unknown as EachMessagePayload;
}

const headers = {
  'message-id': MESSAGE_ID,
  type: 'catalog.show.published.v1',
  traceparent: TRACEPARENT,
};

interface Write {
  readonly document: ShowDocument;
  readonly version: number;
}

/** A fake index: it records what it was asked to write and never reaches a cluster. */
function fakeIndex(writes: Write[], outcome: IndexWrite = 'indexed'): ShowIndex {
  return {
    put(document: ShowDocument, version: number): Promise<IndexWrite> {
      writes.push({ document, version });
      return Promise.resolve(outcome);
    },
  };
}

interface Ledger {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** `claimed` decides whether the dedup insert reports a fresh identifier. */
function fakeDataSource(claimed: boolean, ledger: Ledger[] = []): DataSource {
  const manager = {
    createQueryBuilder: () => ({
      insert: () => ({
        into: () => ({
          values: () => ({
            orIgnore: () => ({
              returning: () => ({
                execute: () => Promise.resolve({ raw: claimed ? [{ id: MESSAGE_ID }] : [] }),
              }),
            }),
          }),
        }),
      }),
    }),
    query: (sql: string, params: readonly unknown[]) => {
      ledger.push({ sql, params });
      return Promise.resolve([]);
    },
  };
  return {
    transaction: (run: (m: unknown) => Promise<unknown>) => run(manager),
  } as unknown as DataSource;
}

describe('applyMessage', () => {
  it('projects a show it has not seen into the index and records that it did', async () => {
    const writes: Write[] = [];
    const ledger: Ledger[] = [];

    const outcome = await applyMessage(
      fakeDataSource(true, ledger),
      fakeIndex(writes),
      message(headers),
      INDEXED_AT,
    );

    expect(outcome).toBe('applied');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.document).toEqual({
      show_id: SHOW_ID,
      channel_id: '01a0d537-0abe-71f1-9ee1-000000000001',
      artist_id: '01a0d537-0abe-71f1-9ee1-000000000002',
      category_id: 'theatre',
      genre_ids: ['comedy'],
      tag_ids: ['family'],
      runtime_min: 95,
      language_dependency: LanguageDependency.ESSENTIAL,
      spoken_languages: ['fr-FR'],
      subtitle_languages: ['en-GB'],
      surtitle_languages: [],
      media: {
        wide: [{ url: 'https://cdn.example.test/w.jpg', width_px: 1280, height_px: 720 }],
        poster: [],
      },
      published_at: OCCURRED_AT.toISOString(),
      indexed_at: INDEXED_AT.toISOString(),
    });
    expect(ledger).toHaveLength(1);
  });

  it('versions the document by when the fact happened, not by when it was read', () => {
    // The version is what stops a message coming back off the retry topic from
    // overwriting a newer one. Taken from the clock instead, a five-minute-old
    // message would carry the FRESHEST version of all and win every conflict.
    const writes: Write[] = [];
    return applyMessage(fakeDataSource(true), fakeIndex(writes), message(headers), INDEXED_AT).then(
      () => {
        expect(writes[0]?.version).toBe(OCCURRED_AT.getTime());
      },
    );
  });

  it('records the projection once when the same message is delivered twice', async () => {
    const writes: Write[] = [];
    const ledger: Ledger[] = [];

    // Delivery is at least once, always. The dedup insert returning no row is
    // what says the second arrival must change nothing in the database.
    const outcome = await applyMessage(
      fakeDataSource(false, ledger),
      fakeIndex(writes),
      message(headers),
      INDEXED_AT,
    );

    expect(outcome).toBe('duplicate');
    expect(ledger).toHaveLength(0);
  });

  it('still writes the index on a duplicate, which is what makes a replay a rebuild', async () => {
    // Deliberate, not an oversight: the index write happens BEFORE the dedup
    // check, so replaying the topic restores an index that was lost even though
    // every message is already in `processed_message`. Short-circuiting on the
    // duplicate would save one write and take the rebuild path away with it.
    const writes: Write[] = [];
    await applyMessage(fakeDataSource(false), fakeIndex(writes), message(headers), INDEXED_AT);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.document.show_id).toBe(SHOW_ID);
  });

  it('ignores a type it does not handle, without touching the index', async () => {
    const writes: Write[] = [];
    const ledger: Ledger[] = [];

    const outcome = await applyMessage(
      fakeDataSource(true, ledger),
      fakeIndex(writes),
      message({ ...headers, type: 'catalog.show.updated.v1' }),
      INDEXED_AT,
    );

    expect(outcome).toBe('ignored');
    expect(writes).toHaveLength(0);
    expect(ledger).toHaveLength(0);
  });

  it('refuses a message with no message-id instead of inventing one', async () => {
    const { 'message-id': _omitted, ...withoutId } = headers;
    await expect(
      applyMessage(fakeDataSource(true), fakeIndex([]), message(withoutId), INDEXED_AT),
    ).rejects.toThrow(/no message-id/);
  });

  it('refuses bytes that are not this schema rather than retrying them for ever', async () => {
    const notProtobuf = Buffer.from('{"showId":"whatever"}', 'utf8');
    await expect(
      applyMessage(fakeDataSource(true), fakeIndex([]), message(headers, notProtobuf), INDEXED_AT),
    ).rejects.toThrow(/does not decode as ShowPublished/);
  });

  it('refuses a message with no value', async () => {
    await expect(
      applyMessage(fakeDataSource(true), fakeIndex([]), message(headers, null), INDEXED_AT),
    ).rejects.toThrow(/has no value/);
  });

  it('refuses a publication with no occurred_at, because there is no version to index it at', async () => {
    const writes: Write[] = [];
    await expect(
      applyMessage(
        fakeDataSource(true),
        fakeIndex(writes),
        message(headers, value({ occurredAt: undefined })),
        INDEXED_AT,
      ),
    ).rejects.toThrow(/no occurred_at/);
    expect(writes).toHaveLength(0);
  });

  it('carries the traceparent into the projection ledger', async () => {
    const ledger: Ledger[] = [];
    await applyMessage(fakeDataSource(true, ledger), fakeIndex([]), message(headers), INDEXED_AT);

    expect(ledger[0]?.params).toEqual([SHOW_ID, OCCURRED_AT.getTime(), TRACEPARENT, INDEXED_AT]);
  });

  it('keeps the traceparent out of the document a surface will read', async () => {
    // Trace context is operational data. A search hit is a product payload, and
    // the `_source` of one is served straight to a client.
    const writes: Write[] = [];
    await applyMessage(fakeDataSource(true), fakeIndex(writes), message(headers), INDEXED_AT);

    expect(JSON.stringify(writes[0]?.document)).not.toContain(TRACEPARENT);
  });

  it('reads Debezium’s literal "null" as absence, not as a value', async () => {
    // Debezium renders a NULL column as the four characters `null`. Storing
    // that string is how a trace id becomes the word "null" in a dashboard.
    const ledger: Ledger[] = [];
    await applyMessage(
      fakeDataSource(true, ledger),
      fakeIndex([]),
      message({ ...headers, traceparent: 'null' }),
      INDEXED_AT,
    );

    expect(ledger[0]?.params[2]).toBeNull();
  });

  it('keeps an unknown language dependency neutral rather than dropping the show', async () => {
    // A producer one version ahead sends a member this build has no name for.
    // Refusing the document would take a whole show out of the catalogue over a
    // field that decides a badge (critical-rules.md §10).
    const writes: Write[] = [];
    const unknownMember = 9 as WireLanguageDependency;

    const outcome = await applyMessage(
      fakeDataSource(true),
      fakeIndex(writes),
      message(headers, value({ languageDependency: unknownMember })),
      INDEXED_AT,
    );

    expect(outcome).toBe('applied');
    expect(writes[0]?.document.language_dependency).toBeNull();
  });

  it('reads an unspecified language dependency as absent, never as `none`', async () => {
    // Protobuf's zero value is what an older producer sends when it has nothing
    // to say. `none` would state, as a fact, that a show has no language
    // barrier because nobody filled the field in.
    const writes: Write[] = [];
    await applyMessage(
      fakeDataSource(true),
      fakeIndex(writes),
      message(headers, value({ languageDependency: WireLanguageDependency.UNSPECIFIED })),
      INDEXED_AT,
    );

    expect(writes[0]?.document.language_dependency).toBeNull();
  });

  it('marks a message processed, and says superseded, when a newer document already won', async () => {
    // ⚠ Claimed, not left for a retry: `external_gte` refusing an older write means the index is
    //   already correct, and a retry would fail the same way three times and dead-letter it.
    const outcome = await applyMessage(
      fakeDataSource(true),
      fakeIndex([], 'superseded'),
      message(headers),
      INDEXED_AT,
    );

    expect(outcome).toBe('superseded');
  });

  it('reports a redelivery as duplicate even when it is also older', async () => {
    const outcome = await applyMessage(
      fakeDataSource(false),
      fakeIndex([], 'superseded'),
      message(headers),
      INDEXED_AT,
    );

    expect(outcome).toBe('duplicate');
  });
});
