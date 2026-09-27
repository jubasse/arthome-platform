import { ArtistUpdatedSchema } from '@arthome-platform/events';
import { claimMessage, type Outcome } from '@arthome-platform/messaging';
import { fromBinary } from '@bufbuild/protobuf';
import type { EachMessagePayload } from 'kafkajs';
import { In, type DataSource, type EntityManager } from 'typeorm';

import { ArtistProjection } from './artist-projection.entity.js';
import type { DateProjection } from './date-projection.entity.js';
import { decodedOrRefused, incomingOf } from './incoming.js';
import { ShowProjection } from './show-projection.entity.js';
import { stated } from './wire.js';
import { dateDocumentOf } from '../index/compose.js';
import type { Indices } from '../index/opensearch-client.js';

const ARTIST_UPDATED = 'catalog.artist.updated.v1';

export interface ArtistFact {
  readonly channelId: string;
  readonly artistId: string;
  readonly publicName: string;
  /** `occurred_at` in epoch milliseconds. */
  readonly version: number;
}

export function artistFactOf(value: Uint8Array): ArtistFact {
  const event = fromBinary(ArtistUpdatedSchema, value);
  return {
    channelId: event.channelId,
    artistId: event.artistId,
    publicName: event.publicName,
    version: stated(event.occurredAt, `artist ${event.artistId}`).getTime(),
  };
}

/**
 * Every public date of the channel. A first delivery advances each document's version under the
 * row lock; a duplicate rewrites them at their current one, as the show consumer does.
 */
async function channelDatesOf(
  manager: EntityManager,
  channelId: string,
  advance: boolean,
): Promise<DateProjection[]> {
  if (!advance) {
    return manager.query<DateProjection[]>(
      "SELECT * FROM date_projection WHERE scheduled->>'channel_id' = $1",
      [channelId],
    );
  }
  const [rows] = await manager.query<[DateProjection[], number]>(
    `UPDATE date_projection SET doc_version = doc_version + 1, indexed_at = now()
      WHERE scheduled->>'channel_id' = $1
      RETURNING *`,
    [channelId],
  );
  return rows;
}

/**
 * Same order as the other consumers: the read model commits, then the channel's date documents
 * are rewritten from it, each with its show's fields and the artist's new name.
 */
export async function applyArtistMessage(
  dataSource: DataSource,
  indices: Indices,
  payload: EachMessagePayload,
  now: Date = new Date(),
): Promise<Outcome> {
  const incoming = incomingOf(payload);
  if (incoming.type !== ARTIST_UPDATED) return 'ignored';
  const fact = decodedOrRefused(payload, incoming, artistFactOf);

  const result = await dataSource.transaction(async (manager) => {
    const firstDelivery = await claimMessage(manager, incoming.messageId, payload.topic);
    const current = await manager.findOne(ArtistProjection, {
      where: { channel_id: fact.channelId },
      lock: { mode: 'pessimistic_write' },
    });
    if (firstDelivery && current !== null && fact.version < Number(current.version)) {
      return { outcome: 'superseded' as const, artist: current, dates: [], shows: [] };
    }
    const artist =
      firstDelivery || current === null
        ? await manager.save(ArtistProjection, {
            channel_id: fact.channelId,
            artist_id: fact.artistId,
            public_name: fact.publicName,
            version: String(fact.version),
          })
        : current;
    const dates = await channelDatesOf(manager, fact.channelId, firstDelivery);
    const showIds = [
      ...new Set(dates.flatMap((date) => (date.show_id === null ? [] : [date.show_id]))),
    ];
    const shows = await manager.findBy(ShowProjection, { show_id: In(showIds) });
    return {
      outcome: firstDelivery ? ('applied' as const) : ('duplicate' as const),
      artist,
      dates,
      shows,
    };
  });

  for (const date of result.dates) {
    if (date.scheduled === null) continue;
    const show = result.shows.find((candidate) => candidate.show_id === date.show_id) ?? null;
    await indices.dates.put(
      dateDocumentOf({ ...date, scheduled: date.scheduled }, show, result.artist, now),
      Number(date.doc_version),
    );
  }
  return result.outcome;
}
