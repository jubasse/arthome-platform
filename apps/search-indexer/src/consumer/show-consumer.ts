// ⚠ THE CATALOG WIRE TYPES ARRIVE THROUGH THE BARREL, AND THEY DID NOT ALWAYS.
//   `libs/events/src/index.ts` re-exported only `common` and `identity` when
//   this file was written; the catalog context was generated but unreachable
//   through the package's `exports` map, and the service could not compile.
//   That line was added by the agent building `catalog`, which needs the same
//   types to PRODUCE what this file CONSUMES. Nothing is worked around here: a
//   local re-declaration would be a second copy of a contract `buf breaking`
//   protects, and a deep import into the package's `src/` is what
//   `no-restricted-imports` forbids — "going through `exports` is going through
//   the contract".
import {
  LanguageDependency as WireLanguageDependency,
  ShowPublishedSchema,
  type ShowPublished,
} from '@arthome-platform/events';
import { PermanentError, header, type Outcome } from '@arthome-platform/messaging';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate, timestampMs } from '@bufbuild/protobuf/wkt';
import type { EachMessagePayload } from 'kafkajs';
import type { DataSource } from 'typeorm';

import { LanguageDependency } from '@arthome/core';

import { ProcessedMessage } from './processed-message.entity.js';
import type { ShowIndex } from '../index/opensearch-client.js';
import type { IndexedRendition, ShowDocument } from '../index/show-document.js';

/**
 * The one message type this consumer applies.
 *
 * The topic carries more than one (`catalog.show.updated.v1` is next), so the
 * header is what selects a handler, and the `.v<N>` suffix is what lets the
 * shape change without breaking this reader (events.md §1.3).
 */
const SHOW_PUBLISHED = 'catalog.show.published.v1';

/**
 * The wire's language dependency, read as the domain's.
 *
 * ⚠ NOT ONE STRING LITERAL ON EITHER SIDE. Both columns are imported members —
 *   the protobuf enum on the left, `@arthome/core`'s vocabulary on the right —
 *   so this is a mapping between two declared vocabularies and not a third copy
 *   of either. A member added to the proto makes this `Record` incomplete and
 *   the build fails, which is the only reason the mapping is allowed to exist
 *   at all (code-conventions.md §5.2: a transform is a parallel literal table
 *   wearing a codec's costume, unless something fails when it drifts).
 *
 * ⚠ `UNSPECIFIED` MAPS TO `null`, NOT TO A MEMBER. Protobuf's zero value is
 *   what an older producer sends when it has nothing to say; turning it into
 *   `none` would state, as a fact, that a show has no language barrier because
 *   nobody filled the field in.
 */
const DOMAIN_LANGUAGE_DEPENDENCY: Readonly<
  Record<WireLanguageDependency, LanguageDependency | null>
> = {
  [WireLanguageDependency.UNSPECIFIED]: null,
  [WireLanguageDependency.NONE]: LanguageDependency.NONE,
  [WireLanguageDependency.HELPFUL]: LanguageDependency.HELPFUL,
  [WireLanguageDependency.ESSENTIAL]: LanguageDependency.ESSENTIAL,
};

/**
 * ⚠ AN UNKNOWN MEMBER IS NEUTRAL, NEVER A REJECTION (critical-rules.md §10). A
 *   producer one version ahead sends an integer this build has no name for, and
 *   refusing the document over it would take a whole show out of the catalogue
 *   because of a field that decides a badge.
 *
 *   It is dropped rather than "kept raw", and that is the one place this
 *   departs from `parseTolerant`: what arrives here is an unnamed INTEGER, not
 *   a string. Storing `9` as a keyword would put a term in the index that no
 *   filter can ever legitimately ask for, and that no surface can label.
 */
function domainLanguageDependency(wire: WireLanguageDependency): LanguageDependency | null {
  return DOMAIN_LANGUAGE_DEPENDENCY[wire] ?? null;
}

function indexedRendition(source: {
  url: string;
  widthPx: number;
  heightPx: number;
}): IndexedRendition {
  return { url: source.url, width_px: source.widthPx, height_px: source.heightPx };
}

/**
 * The projection: one event in, one document out, and nothing else consulted.
 *
 * ⚠ PURE, AND THAT PURITY IS WHAT MAKES THE DUAL WRITE SAFE. Because the
 *   document depends on the event and on nothing that has happened since,
 *   writing it twice is indistinguishable from writing it once — which is the
 *   whole licence for re-indexing on a replay. The day this projection reads
 *   the current document and increments something, the ordering decided in
 *   `applyMessage` stops being correct and has to be revisited.
 *
 * @param indexedAt - injected so a test asserts a document rather than a clock.
 */
export function projectShow(event: ShowPublished, indexedAt: Date): ShowDocument {
  // ⚠ ABSENT MEDIA IS EMPTY MEDIA, NOT A REFUSAL. A show published before its
  //   images were uploaded is still a show somebody must be able to find; a
  //   result card with no picture is a degradation, an absent result is a bug.
  const media = event.media;

  return {
    show_id: event.showId,
    channel_id: event.channelId,
    artist_id: event.artistId,
    category_id: event.categoryId,
    genre_ids: event.genreIds,
    tag_ids: event.tagIds,
    runtime_min: event.runtimeMin,
    language_dependency: domainLanguageDependency(event.languageDependency),
    spoken_languages: event.spokenLanguages,
    subtitle_languages: event.subtitleLanguages,
    surtitle_languages: event.surtitleLanguages,
    media: {
      wide: media === undefined ? [] : media.wide.map(indexedRendition),
      poster: media === undefined ? [] : media.poster.map(indexedRendition),
    },
    // ISO 8601 UTC on the wire and in the document (critical-rules.md §6). The
    // `date` mapping parses it; an epoch integer would index identically and
    // would be unreadable in every console that ever shows a hit.
    published_at: timestampDate(occurredAt(event)).toISOString(),
    indexed_at: indexedAt.toISOString(),
  };
}

/**
 * ⚠ `occurred_at` IS THE VERSION, SO ITS ABSENCE IS PERMANENT. Protobuf makes
 *   every field optional on the wire, so a message with no timestamp decodes
 *   happily and would be projected at version 0 — losing to every other write
 *   for ever, silently. There is no waiting that adds a timestamp to bytes that
 *   were sent without one.
 */
function occurredAt(event: ShowPublished): NonNullable<ShowPublished['occurredAt']> {
  const value = event.occurredAt;
  if (value === undefined) {
    throw new PermanentError(
      `show ${event.showId} was published with no occurred_at — there is no version to index it at`,
    );
  }
  return value;
}

/**
 * Apply one message: decode, project, index, dedupe — in that order.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠ THE ORDERING QUESTION, WHICH IS THE ONE DECISION IN THIS FILE.
 *
 *   An OpenSearch write and a Postgres transaction cannot commit together.
 *   There is no ordering that is safe; there are two orderings, each wrong in a
 *   different way, and the job is to choose WHICH WAY TO BE WRONG.
 *
 *   A · index first, then commit `processed_message` — CHOSEN.
 *     Crash in between: the document is in the index, the row is not. The
 *     message is redelivered, the handler indexes the same document again — the
 *     projection is pure, so the bytes are the same — and commits the row.
 *     THE FAILURE MODE IS A REPEAT.
 *
 *   B · commit `processed_message` first, then index.
 *     Crash in between: Postgres says "processed", the index has nothing. The
 *     redelivery finds the row, reports `duplicate`, and skips. The show is
 *     absent from search FOR EVER, nothing logs it, no alert fires, and the
 *     only repair is a full reindex that nobody knows to run.
 *     THE FAILURE MODE IS A SILENT GAP.
 *
 *   A repeat is absorbed by an idempotent write. A gap is absorbed by nothing.
 *   So the non-transactional, idempotent write goes FIRST and the transactional
 *   bookkeeping goes LAST — and the general form of that, worth keeping past
 *   this file, is: order two writes that cannot commit together so that the
 *   crash window duplicates rather than drops.
 *
 *   ⚠ AND THE COST OF A IS NOT A COST, IT IS THE REBUILD PATH. Because the
 *     index write happens BEFORE the deduplication check, replaying
 *     `arthome.catalog.show` from the beginning rebuilds the index even though
 *     every message is a duplicate — the writes land, the rows do not move.
 *     Under B the same replay would do nothing at all, and restoring a lost
 *     index would first require truncating `processed_message`: deleting the
 *     evidence in order to repair the thing the evidence was about.
 *
 *   What is NOT claimed: that a repeat is free. A redelivered message costs one
 *   redundant index write. A cheap `SELECT` before the index write would avoid
 *   it — and would also disable the rebuild path above, so it is deliberately
 *   absent.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ THE DEDUP INSERT AND THE BOOKKEEPING SHARE ONE TRANSACTION AND ONE MANAGER.
 *   `orIgnore().returning('id')` returns no row when the identifier is already
 *   there, and that is the signal to skip — not a prior SELECT, which would
 *   leave a window in which two consumers both see nothing.
 */
export async function applyMessage(
  dataSource: DataSource,
  index: ShowIndex,
  payload: EachMessagePayload,
  now: Date = new Date(),
): Promise<Outcome> {
  const messageId = header(payload, 'message-id');
  if (messageId === null) {
    // PERMANENT: no amount of waiting grows a header. And it cannot be given a
    // generated one — that would make the message undeduplicable and silently
    // reprocessable for ever (events.md §1.3).
    throw new PermanentError(
      `message on ${payload.topic} has no message-id header — permanent, not a default`,
    );
  }

  const type = header(payload, 'type');
  if (type !== SHOW_PUBLISHED) return 'ignored';

  const value = payload.message.value;
  if (value === null) throw new PermanentError(`message ${messageId} has no value`);

  let event: ShowPublished;
  try {
    event = fromBinary(ShowPublishedSchema, new Uint8Array(value));
  } catch (cause) {
    // PERMANENT: bytes that are not this schema will not become this schema.
    throw new PermanentError(
      `message ${messageId} does not decode as ShowPublished: ${String(cause)}`,
    );
  }

  const version = timestampMs(occurredAt(event));
  const document = projectShow(event, now);

  // STEP ONE, outside any transaction. A failure here has written nothing and
  // claimed nothing, so it is safe to retry — and `messaging` will.
  //
  // ⚠ THE ANSWER IS DISCARDED ON PURPOSE. `indexed` and `superseded` both mean
  //   "the index now holds this show at a version at least this new", and that
  //   is the only thing the bookkeeping below needs to be true. Turning a
  //   `superseded` into a failure would retry a message that has nothing left
  //   to do; turning it into `duplicate` would say something false about the
  //   MESSAGE, which is not the thing that was superseded.
  await index.put(document, version);

  // STEP TWO. Everything below is local, short and atomic: no network call is
  // made with a transaction open, which is what keeps a slow index from holding
  // database connections.
  return dataSource.transaction(async (manager) => {
    const claimed = await manager
      .createQueryBuilder()
      .insert()
      .into(ProcessedMessage)
      .values({ id: messageId, topic: payload.topic })
      .orIgnore()
      .returning('id')
      .execute();

    if ((claimed.raw as unknown[]).length === 0) return 'duplicate';

    // ⚠ RAW SQL, AND NOT BECAUSE IT IS QUICKER. TypeORM's `orUpdate` carries no
    //   condition on the DO UPDATE branch, and the condition is the whole
    //   point. The table name is written out here; `show-projection.entity.ts`
    //   and the migration are what own it, and `data-source.ts` registers both.
    //
    // ⚠ THE `WHERE` IS NOT DECORATION. A message off the retry topic can arrive
    //   after a newer one for the same show; OpenSearch refuses that write
    //   (`external_gte`), so the ledger must refuse it too — otherwise the one
    //   table an operator consults to find out what the index holds is the one
    //   thing that has gone backwards.
    await manager.query(
      `INSERT INTO show_projection (show_id, version, traceparent, indexed_at)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (show_id) DO UPDATE
               SET version     = excluded.version,
                   traceparent = excluded.traceparent,
                   indexed_at  = excluded.indexed_at
             WHERE excluded.version >= show_projection.version`,
      [document.show_id, version, header(payload, 'traceparent'), now],
    );

    return 'applied';
  });
}
