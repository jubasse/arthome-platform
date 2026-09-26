import {
  LanguageDependency as WireLanguageDependency,
  ShowPublishedSchema,
} from '@arthome-platform/events';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EachMessagePayload } from 'kafkajs';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProcessedMessage } from './processed-message.entity.js';
import { applyMessage } from './show-consumer.js';
import { ShowProjection } from './show-projection.entity.js';
import {
  createOpenSearchClient,
  ensureShowIndex,
  showIndex,
  type ShowIndex,
} from '../index/opensearch-client.js';
import { SHOW_INDEX_ALIAS, SHOW_INDEX_CONCRETE } from '../index/show-document.js';
import { Initial1758700400000 } from '../migrations/1758700400000-initial.js';

/**
 * The indexer against REAL OpenSearch and REAL Postgres.
 *
 * THIS IS THE SEGMENT THE UNIT TESTS CANNOT REACH. `show-consumer.spec.ts`
 *   drives the handler with a fake `ShowIndex`, which proves the handler's logic
 *   and nothing about the index: a mapping that rejects the document, a
 *   normalizer that does not lower-case, and an `external_gte` version that does
 *   not actually refuse an older write all pass a fake without complaint. Those
 *   three are asserted here, and only here.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const SHOW_ID = '01a0d55c-0000-7000-8000-000000000001';
const OTHER_SHOW_ID = '01a0d55c-0000-7000-8000-000000000002';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

let stack: StartedStack;
let dataSource: DataSource;
let index: ShowIndex;
let openSearchUrl: string;

interface Fields {
  readonly showId?: string;
  readonly occurredAt?: Date;
  readonly runtimeMin?: number;
}

function value(fields: Fields = {}): Buffer {
  return Buffer.from(
    toBinary(
      ShowPublishedSchema,
      create(ShowPublishedSchema, {
        showId: fields.showId ?? SHOW_ID,
        channelId: '01a0d55c-0000-7000-8000-0000000000c1',
        artistId: '01a0d55c-0000-7000-8000-0000000000a1',
        categoryId: 'theatre',
        genreIds: ['comedy'],
        tagIds: ['family'],
        runtimeMin: fields.runtimeMin ?? 95,
        languageDependency: WireLanguageDependency.ESSENTIAL,
        // Mixed case ON PURPOSE. BCP 47 is case-insensitive, the document keeps
        // what was authored, and the INDEX lower-cases it through the mapping's
        // normalizer. A fake index cannot tell those three apart.
        spokenLanguages: ['fr-FR'],
        subtitleLanguages: ['en-GB'],
        surtitleLanguages: [],
        media: { wide: [{ url: 'https://cdn.example.test/w.jpg', widthPx: 1280, heightPx: 720 }] },
        occurredAt: timestampFromDate(fields.occurredAt ?? new Date('2026-09-25T09:00:00.000Z')),
      }),
    ),
  );
}

function message(messageId: string, body: Buffer = value()): EachMessagePayload {
  return {
    topic: 'arthome.catalog.show',
    partition: 0,
    message: {
      key: Buffer.from(SHOW_ID),
      value: body,
      headers: {
        'message-id': Buffer.from(messageId),
        type: Buffer.from('catalog.show.published.v1'),
        traceparent: Buffer.from(TRACEPARENT),
      },
    },
  } as unknown as EachMessagePayload;
}

/** Read one document back through the alias, which is all a reader ever names. */
async function readDocument(showId: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${openSearchUrl}/${SHOW_INDEX_ALIAS}/_doc/${showId}`);
  if (response.status === 404) return null;
  const body = (await response.json()) as { _source: Record<string, unknown> };
  return body._source;
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, opensearch: true, startupTimeoutMs: STARTUP_MS });

  const database = await createDatabase(stack.postgres, 'search_itest');
  dataSource = await applyMigrations(database, {
    entities: [ProcessedMessage, ShowProjection],
    migrations: [Initial1758700400000],
  });

  openSearchUrl = stack.opensearch.url;
  const client = createOpenSearchClient(openSearchUrl);
  await ensureShowIndex(client);
  index = showIndex(client);
}, STARTUP_MS);

afterAll(async () => {
  await dataSource?.destroy();
  await stack?.stop();
});

describe('the indexer against a real index', () => {
  it(
    'writes a document the mapping accepts, and lower-cases the language through the normalizer',
    async () => {
      const outcome = await applyMessage(
        dataSource,
        index,
        message('01a0d55c-0000-7000-8000-000000000101'),
      );
      expect(outcome).toBe('applied');

      const document = await readDocument(SHOW_ID);
      expect(document).not.toBeNull();
      // The document keeps what was authored…
      expect(document?.spoken_languages).toEqual(['fr-FR']);

      // …and the index holds it lower-cased, which is the only reason a viewer
      // searching `FR-fr` finds it. Asserted through a term query, because the
      // normalizer applies to the indexed term and not to `_source`.
      await fetch(`${openSearchUrl}/${SHOW_INDEX_ALIAS}/_refresh`, { method: 'POST' });
      const hits = (await (
        await fetch(`${openSearchUrl}/${SHOW_INDEX_ALIAS}/_search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: { term: { spoken_languages: 'FR-fr' } } }),
        })
      ).json()) as { hits: { total: { value: number } } };
      expect(hits.hits.total.value).toBe(1);
    },
    CASE_MS,
  );

  it(
    'still writes the index on a duplicate — the claim that makes a replay a rebuild',
    async () => {
      const messageId = '01a0d55c-0000-7000-8000-000000000201';
      expect(await applyMessage(dataSource, index, message(messageId))).toBe('applied');

      // DROP THE WHOLE INDEX, NOT THE DOCUMENT — and the difference is a real
      //   operational fact, found by writing this test the other way first.
      //
      //   Deleting one document leaves a TOMBSTONE carrying its version, kept
      //   for `index.gc_deletes` (60 s by default). The write path uses
      //   `version_type: external_gte` with the event's `occurred_at` as the
      //   version, so replaying the SAME event offers the SAME version, the
      //   tombstone refuses it, and `put` answers `superseded`: the document
      //   stays gone. So a replay does NOT repair a single deleted document
      //   within that window.
      //
      //   Losing an index — the disaster the rebuild path exists for — resets
      //   versioning with it, and that is what is reproduced here.
      //   BY ITS CONCRETE NAME, NOT BY THE ALIAS. OpenSearch refuses to delete
      //     an index named through an alias — "specify the corresponding
      //     concrete indices instead" — and the refusal is a 400 body, not a
      //     thrown error. Written the short way first, this test then asserted a
      //     deletion that had not happened, and read the untouched document back.
      //     Hence the status assertion: an ignored HTTP status is a test that
      //     proves the opposite of what it says.
      const dropped = await fetch(`${openSearchUrl}/${SHOW_INDEX_CONCRETE}`, { method: 'DELETE' });
      expect(dropped.ok).toBe(true);
      await ensureShowIndex(createOpenSearchClient(openSearchUrl));
      expect(await readDocument(SHOW_ID)).toBeNull();

      // The redelivery reports `duplicate` — and rebuilds the document anyway.
      // Under the other write ordering this replay would do nothing, and
      // repairing the index would first require truncating processed_message:
      // deleting the evidence in order to repair what the evidence was about.
      expect(await applyMessage(dataSource, index, message(messageId))).toBe('duplicate');
      expect(await readDocument(SHOW_ID)).not.toBeNull();
    },
    CASE_MS,
  );

  it(
    'refuses an older event rather than letting a reordered replay undo a newer one',
    async () => {
      const newer = value({
        showId: OTHER_SHOW_ID,
        occurredAt: new Date('2026-09-25T12:00:00.000Z'),
        runtimeMin: 120,
      });
      const older = value({
        showId: OTHER_SHOW_ID,
        occurredAt: new Date('2026-09-25T08:00:00.000Z'),
        runtimeMin: 60,
      });

      expect(
        await applyMessage(
          dataSource,
          index,
          message('01a0d55c-0000-7000-8000-000000000301', newer),
        ),
      ).toBe('applied');
      expect((await readDocument(OTHER_SHOW_ID))?.runtime_min).toBe(120);

      // THE GUARD THAT A FAKE INDEX CANNOT PROVE. A retry topic reorders one
      // key's events: a message that waited five minutes comes back behind
      // later ones for the same show. `version_type: external_gte` is what
      // makes the late arrival lose instead of overwriting.
      expect(
        await applyMessage(
          dataSource,
          index,
          message('01a0d55c-0000-7000-8000-000000000302', older),
        ),
      ).toBe('superseded');
      expect((await readDocument(OTHER_SHOW_ID))?.runtime_min).toBe(120);
    },
    CASE_MS,
  );
});
