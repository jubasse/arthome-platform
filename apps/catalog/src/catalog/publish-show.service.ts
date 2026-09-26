import { ShowPublishedSchema } from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { Bilingual, LanguageDependency, MediaSet } from '@arthome/core';

import { Show } from './show.entity.js';
import { writeCatalogEvent } from '../catalog-events.js';
import { WIRE_LANGUAGE_DEPENDENCY, wireLocalizedTexts } from '../wire.js';

export interface PublishShowCommand {
  readonly channelId: string;
  readonly artistId: string;
  readonly categoryId: string;
  readonly genreIds: readonly string[];
  readonly tagIds: readonly string[];
  readonly runtimeMin: number;
  readonly languageDependency: LanguageDependency;
  readonly spokenLanguages: readonly string[];
  readonly subtitleLanguages: readonly string[];
  readonly surtitleLanguages: readonly string[];
  readonly media: MediaSet;
  readonly title: Bilingual;
  readonly synopsis: Bilingual;
  readonly traceparent: string | null;
}

export interface PublishedShow {
  readonly showId: string;
  readonly messageId: string;
}

@Injectable()
export class PublishShowService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * The transaction is the feature. Never `save()` then `emit()`: a crash between the two
   *   loses the event and a rollback after the emission invents one. Both writes go through
   *   the same `manager`.
   * `traceparent` is injected here, not when the message is published: the relay runs
   *   outside this request, so by the time Debezium reads the row the causing context is
   *   gone (events.md §1.3).
   */
  async publish(command: PublishShowCommand): Promise<PublishedShow> {
    const showId = uuidv7();
    const occurredAt = new Date();

    const event = create(ShowPublishedSchema, {
      showId,
      channelId: command.channelId,
      artistId: command.artistId,
      categoryId: command.categoryId,
      genreIds: [...command.genreIds],
      tagIds: [...command.tagIds],
      runtimeMin: command.runtimeMin,
      languageDependency: WIRE_LANGUAGE_DEPENDENCY[command.languageDependency],
      spokenLanguages: [...command.spokenLanguages],
      subtitleLanguages: [...command.subtitleLanguages],
      surtitleLanguages: [...command.surtitleLanguages],
      // Not converted, which is why the command's type is core's `MediaSet`: core's
      // `Rendition` and `arthome.common.v1.ImageRendition` agree field for field.
      media: { wide: [...command.media.wide], poster: [...command.media.poster] },
      occurredAt: timestampFromDate(occurredAt),
      title: wireLocalizedTexts(command.title),
      synopsis: wireLocalizedTexts(command.synopsis),
    });

    let messageId = '';
    await this.dataSource.transaction(async (manager) => {
      await manager.insert(Show, {
        id: showId,
        channel_id: command.channelId,
        artist_id: command.artistId,
        category_id: command.categoryId,
        genre_ids: [...command.genreIds],
        tag_ids: [...command.tagIds],
        runtime_min: command.runtimeMin,
        language_dependency: command.languageDependency,
        spoken_languages: [...command.spokenLanguages],
        subtitle_languages: [...command.subtitleLanguages],
        surtitle_languages: [...command.surtitleLanguages],
        media: command.media,
        title: command.title,
        synopsis: command.synopsis,
      });

      messageId = await writeCatalogEvent(
        manager,
        {
          type: 'catalog.show.published.v1',
          key: showId,
          // Serialised here, by the producer; Debezium transports the bytes and reads none.
          payload: toBinary(ShowPublishedSchema, event),
          traceparent: command.traceparent,
        },
        occurredAt,
      );
    });

    return { showId, messageId };
  }
}
