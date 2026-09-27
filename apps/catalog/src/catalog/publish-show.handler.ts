import { ShowPublishedSchema } from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import type { EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { Bilingual, Instant } from '@arthome/core';

import { PublishShow, type PublishedShow } from './publish-show.command.js';
import { Show } from './show.entity.js';
import { writeCatalogEvent } from '../catalog-events.js';
import { CatalogTransactions } from '../catalog-transactions.js';
import { showSlugCandidates } from '../dates/slug.js';
import { LinkKind } from '../public/resolve-query.schema.js';
import { UNSCOPED, reservedForAnother } from '../public/slug-aliases.js';
import { WIRE_LANGUAGE_DEPENDENCY, wireLocalizedTexts } from '../wire.js';

@CommandHandler(PublishShow)
export class PublishShowHandler implements ICommandHandler<PublishShow> {
  public constructor(private readonly transactions: CatalogTransactions) {}

  /**
   * The transaction is the feature. Never `save()` then `emit()`: a crash between the two
   *   loses the event and a rollback after the emission invents one. Both writes go through
   *   the same `manager`.
   * `traceparent` is injected here, not when the message is published: the relay runs
   *   outside this request, so by the time Debezium reads the row the causing context is
   *   gone (events.md §1.3).
   */
  public async execute({ show, traceparent }: PublishShow): Promise<PublishedShow> {
    const showId = uuidv7();
    const occurredAt = new Date();

    const event = create(ShowPublishedSchema, {
      showId,
      channelId: show.channelId,
      artistId: show.artistId,
      categoryId: show.categoryId,
      genreIds: [...show.genreIds],
      tagIds: [...show.tagIds],
      runtimeMin: show.runtimeMin,
      languageDependency: WIRE_LANGUAGE_DEPENDENCY[show.languageDependency],
      spokenLanguages: [...show.spokenLanguages],
      subtitleLanguages: [...show.subtitleLanguages],
      surtitleLanguages: [...show.surtitleLanguages],
      // Not converted, which is why the command's type is core's `MediaSet`: core's
      // `Rendition` and `arthome.common.v1.ImageRendition` agree field for field.
      media: { wide: [...show.media.wide], poster: [...show.media.poster] },
      occurredAt: timestampFromDate(occurredAt),
      title: wireLocalizedTexts(show.title),
      synopsis: wireLocalizedTexts(show.synopsis),
    });

    const messageId = await this.transactions.run(async ({ manager }) => {
      const slug = await freeShowSlug(manager, show.title, showId, occurredAt.toISOString());
      event.slug = slug;
      await manager.insert(Show, {
        id: showId,
        slug,
        channel_id: show.channelId,
        artist_id: show.artistId,
        category_id: show.categoryId,
        genre_ids: [...show.genreIds],
        tag_ids: [...show.tagIds],
        runtime_min: show.runtimeMin,
        language_dependency: show.languageDependency,
        spoken_languages: [...show.spokenLanguages],
        subtitle_languages: [...show.subtitleLanguages],
        surtitle_languages: [...show.surtitleLanguages],
        media: show.media,
        title: show.title,
        synopsis: show.synopsis,
      });

      return writeCatalogEvent(
        manager,
        {
          type: 'catalog.show.published.v1',
          key: showId,
          // Serialised here, by the producer; Debezium transports the bytes and reads none.
          payload: toBinary(ShowPublishedSchema, event),
          traceparent,
        },
        occurredAt,
      );
    });

    return { showId, messageId };
  }
}

/** The first candidate no show holds and no retired slug still reserves; the index settles a race. */
async function freeShowSlug(
  manager: EntityManager,
  title: Bilingual,
  showId: string,
  now: Instant,
): Promise<string> {
  const candidates = showSlugCandidates(title, showId);
  for (const candidate of candidates) {
    const held = await manager.existsBy(Show, { slug: candidate });
    const key = { kind: LinkKind.SHOW, scope: UNSCOPED, slug: candidate };
    if (!held && !(await reservedForAnother(manager, key, showId, now))) return candidate;
  }
  return showId;
}
