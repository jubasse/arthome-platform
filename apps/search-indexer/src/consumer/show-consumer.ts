import { ShowPublishedSchema, ShowUpdatedSchema } from '@arthome-platform/events';
import type { Outcome } from '@arthome-platform/messaging';
import { fromBinary } from '@bufbuild/protobuf';
import type { EachMessagePayload } from 'kafkajs';
import type { DataSource, EntityManager } from 'typeorm';

import type { DateProjection } from './date-projection.entity.js';
import { claimed, decodedOrRefused, incomingOf } from './incoming.js';
import {
  ShowProjection,
  type PublishedShowFields,
  type UpdatableShowFields,
} from './show-projection.entity.js';
import { bilingualOf, indexedRendition, languageDependencyOf, stated } from './wire.js';
import { dateDocumentOf, showDocumentOf } from '../index/compose.js';
import type { Indices } from '../index/opensearch-client.js';

const SHOW_PUBLISHED = 'catalog.show.published.v1';
const SHOW_UPDATED = 'catalog.show.updated.v1';

export interface ShowFact {
  readonly showId: string;
  /** The fact's `occurred_at` in epoch milliseconds. */
  readonly version: number;
  /** Null for ShowUpdated, which states only the updatable group. */
  readonly published: PublishedShowFields | null;
  readonly updatable: UpdatableShowFields;
}

export function showFactOf(type: string, value: Uint8Array): ShowFact {
  if (type === SHOW_PUBLISHED) {
    const event = fromBinary(ShowPublishedSchema, value);
    const occurredAt = stated(event.occurredAt, `show ${event.showId}`);
    return {
      showId: event.showId,
      version: occurredAt.getTime(),
      published: {
        channel_id: event.channelId,
        artist_id: event.artistId,
        category_id: event.categoryId,
        runtime_min: event.runtimeMin,
        spoken_languages: event.spokenLanguages,
        subtitle_languages: event.subtitleLanguages,
        surtitle_languages: event.surtitleLanguages,
        published_at: occurredAt.toISOString(),
      },
      updatable: {
        genre_ids: event.genreIds,
        tag_ids: event.tagIds,
        language_dependency: languageDependencyOf(event.languageDependency),
        media: {
          wide: event.media?.wide.map(indexedRendition) ?? [],
          poster: event.media?.poster.map(indexedRendition) ?? [],
        },
        title: bilingualOf(event.title),
        synopsis: bilingualOf(event.synopsis),
      },
    };
  }
  const event = fromBinary(ShowUpdatedSchema, value);
  return {
    showId: event.showId,
    version: stated(event.occurredAt, `show ${event.showId}`).getTime(),
    published: null,
    updatable: {
      genre_ids: event.genreIds,
      tag_ids: event.tagIds,
      language_dependency: languageDependencyOf(event.languageDependency),
      media: {
        wide: event.media?.wide.map(indexedRendition) ?? [],
        poster: event.media?.poster.map(indexedRendition) ?? [],
      },
      title: bilingualOf(event.title),
      synopsis: bilingualOf(event.synopsis),
    },
  };
}

/**
 * Each group takes the fact only if the fact is at least as new as what set it, so an update
 * that overtook the publication keeps its fields when the publication lands. Null when neither
 * group moves: the fact is superseded.
 */
export function showAfter(
  row: ShowProjection,
  fact: ShowFact,
  traceparent: string | null,
): ShowProjection | null {
  const takes = (version: string | null): boolean =>
    version === null || fact.version >= Number(version);
  const publishedMoves = fact.published !== null && takes(row.published_version);
  const updatableMoves = takes(row.updatable_version);
  if (!publishedMoves && !updatableMoves) return null;
  return {
    ...row,
    published: publishedMoves ? fact.published : row.published,
    published_version: publishedMoves ? String(fact.version) : row.published_version,
    updatable: updatableMoves ? fact.updatable : row.updatable,
    updatable_version: updatableMoves ? String(fact.version) : row.updatable_version,
    version: String(Math.max(Number(row.version), fact.version)),
    traceparent,
  };
}

async function lockedShow(manager: EntityManager, showId: string): Promise<ShowProjection> {
  await manager.query(
    `INSERT INTO show_projection (show_id, version) VALUES ($1, 0) ON CONFLICT DO NOTHING`,
    [showId],
  );
  return manager.findOneOrFail(ShowProjection, {
    where: { show_id: showId },
    lock: { mode: 'pessimistic_write' },
  });
}

/** Every public date of the show, its document version advanced under the row lock. */
async function recomposedDatesOf(
  manager: EntityManager,
  showId: string,
): Promise<DateProjection[]> {
  const [rows] = await manager.query<[DateProjection[], number]>(
    `UPDATE date_projection SET doc_version = doc_version + 1, indexed_at = now()
      WHERE show_id = $1 AND scheduled IS NOT NULL
      RETURNING *`,
    [showId],
  );
  return rows;
}

function publicDatesOf(manager: EntityManager, showId: string): Promise<DateProjection[]> {
  return manager.query<DateProjection[]>(
    'SELECT * FROM date_projection WHERE show_id = $1 AND scheduled IS NOT NULL',
    [showId],
  );
}

/**
 * The read model commits first and the index is written from it afterwards, never with the
 * transaction open. A crash in between leaves the offset uncommitted: the message comes back as
 * a duplicate, and a duplicate rewrites the documents from the read model at their current
 * versions, which is what makes a replay a rebuild.
 */
export async function applyShowMessage(
  dataSource: DataSource,
  indices: Indices,
  payload: EachMessagePayload,
  now: Date = new Date(),
): Promise<Outcome> {
  const incoming = incomingOf(payload);
  const { type } = incoming;
  if (type !== SHOW_PUBLISHED && type !== SHOW_UPDATED) return 'ignored';
  const fact = decodedOrRefused(payload, incoming, (value) => showFactOf(type, value));

  const result = await dataSource.transaction(async (manager) => {
    const firstDelivery = await claimed(manager, incoming, payload.topic);
    const row = await lockedShow(manager, fact.showId);
    if (!firstDelivery) {
      return {
        outcome: 'duplicate' as const,
        show: row,
        dates: await publicDatesOf(manager, fact.showId),
      };
    }
    const next = showAfter(row, fact, incoming.traceparent);
    if (next === null) return { outcome: 'superseded' as const, show: row, dates: [] };
    await manager.save(ShowProjection, next);
    return {
      outcome: 'applied' as const,
      show: next,
      dates: await recomposedDatesOf(manager, fact.showId),
    };
  });

  if (result.outcome === 'superseded') return result.outcome;
  const document = showDocumentOf(result.show, now);
  if (document !== null) await indices.shows.put(document, Number(result.show.version));
  for (const date of result.dates) {
    if (date.scheduled === null) continue;
    await indices.dates.put(
      dateDocumentOf({ ...date, scheduled: date.scheduled }, result.show, now),
      Number(date.doc_version),
    );
  }
  return result.outcome;
}
