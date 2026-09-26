import {
  LanguageDependency as WireLanguageDependency,
  ShowPublishedSchema,
  type ShowPublished,
} from '@arthome-platform/events';
import {
  header,
  type Outcome,
  PermanentError,
  ProcessedMessage,
} from '@arthome-platform/messaging';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate, timestampMs } from '@bufbuild/protobuf/wkt';
import type { EachMessagePayload } from 'kafkajs';
import type { DataSource } from 'typeorm';

import { LanguageDependency } from '@arthome/core';

import type { ShowIndex } from '../index/opensearch-client.js';
import type { IndexedRendition, ShowDocument } from '../index/show-document.js';

const SHOW_PUBLISHED = 'catalog.show.published.v1';

/**
 * `UNSPECIFIED` maps to `null`, not to `NONE`: protobuf's zero value is what an older
 *   producer sends when it has nothing to say, and `NONE` would assert a fact nobody stated.
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
 * An unknown member — a producer one version ahead — is dropped, not refused: a field
 *   that decides a badge must not take a whole show out of the catalogue.
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
 * Pure, and that is what licenses re-indexing on a replay. The day this reads the
 *   current document, the ordering decided in `applyMessage` has to be revisited.
 */
export function projectShow(event: ShowPublished, indexedAt: Date): ShowDocument {
  // Absent media is empty media, not a refusal: a show published before its images
  //   were uploaded is still one somebody must be able to find.
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
    published_at: timestampDate(occurredAt(event)).toISOString(),
    indexed_at: indexedAt.toISOString(),
  };
}

/**
 * Protobuf makes every field optional, so a message with no timestamp decodes happily
 *   and would index at version 0 — losing to every later write, for ever and silently.
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
 * THE INDEX WRITE COMES BEFORE THE `processed_message` COMMIT, AND THE ORDER IS THE
 *   DECISION. The two cannot commit together: crashing between them either repeats an
 *   idempotent index write (chosen) or leaves the show missing from search for ever
 *   behind a row claiming it was processed. Indexing before the dedup check is also what
 *   lets a replay of the topic rebuild the index, so no `SELECT` is added to skip it.
 */
export async function applyMessage(
  dataSource: DataSource,
  index: ShowIndex,
  payload: EachMessagePayload,
  now: Date = new Date(),
): Promise<Outcome> {
  const messageId = header(payload, 'message-id');
  if (messageId === null) {
    // A generated id would make the message undeduplicable and reprocessable for ever.
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
    throw new PermanentError(
      `message ${messageId} does not decode as ShowPublished: ${String(cause)}`,
    );
  }

  const version = timestampMs(occurredAt(event));
  const document = projectShow(event, now);

  // The data path treats `indexed` and `superseded` alike — either way the index holds this show
  //   at a version at least this new, and the ledger row must still be written. Only the reported
  //   outcome differs: logging `applied` for an older event that changed nothing misleads whoever
  //   is chasing an ordering problem. Found by running one on 2026-09-26.
  const write = await index.put(document, version);

  // No network call is made with the transaction open: a slow index must not hold
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

    // THE `WHERE` IS THE REASON FOR THE RAW SQL — TypeORM's `orUpdate` carries no
    //   condition. A message off the retry topic can arrive after a newer one for the
    //   same show; OpenSearch refuses that write (`external_gte`), so the ledger must
    //   refuse it too, or the table an operator consults goes backwards.
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

    return write === 'superseded' ? 'superseded' : 'applied';
  });
}
