// ⚠ Aliased because `@arthome-platform/events` is a flat barrel: the wire enum and
//   `@arthome/core`'s domain vocabulary share the name `LanguageDependency`, and they are a
//   number and a string. The map below exists so the two are never confused.
import {
  LanguageDependency as WireLanguageDependency,
  ShowPublishedSchema,
} from '@arthome-platform/events';
import { writeOutboxEvent } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LanguageDependency, type MediaSet } from '@arthome/core';

import { Show } from './show.entity.js';

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
  readonly traceparent: string | null;
}

export interface PublishedShow {
  readonly showId: string;
  readonly messageId: string;
}

/**
 * The domain's member → the wire's number.
 *
 * ⚠ An encoding, not a parallel literal table (§5.2): there is one spelling — core's, which
 *   is also the wire's — plus a Protobuf number that cannot be avoided, only written once
 *   from the two generated sides. No string literal on either side.
 * ⚠ `satisfies` points at the domain on purpose: a fourth member of `LANGUAGE_DEPENDENCIES`
 *   fails this build, because the domain leads. The reverse is deliberately not checked —
 *   the proto's `UNSPECIFIED = 0` has no domain member and must not acquire one.
 */
const WIRE_LANGUAGE_DEPENDENCY = {
  [LanguageDependency.NONE]: WireLanguageDependency.NONE,
  [LanguageDependency.HELPFUL]: WireLanguageDependency.HELPFUL,
  [LanguageDependency.ESSENTIAL]: WireLanguageDependency.ESSENTIAL,
} satisfies Record<LanguageDependency, WireLanguageDependency>;

@Injectable()
export class PublishShowService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * ⚠ The transaction is the feature. Never `save()` then `emit()`: a crash between the two
   *   loses the event and a rollback after the emission invents one. Both writes go through
   *   the same `manager`.
   * ⚠ `traceparent` is injected here, not when the message is published: the relay runs
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
      });

      messageId = await writeOutboxEvent(
        manager,
        {
          // `catalog.show` → topic `arthome.catalog.show`, keyed by `show_id` (events.md §3).
          aggregateType: 'catalog.show',
          aggregateId: showId,
          type: 'catalog.show.published.v1',
          // Serialised here, by the producer; Debezium transports the bytes and reads none.
          payload: toBinary(ShowPublishedSchema, event),
          traceparent: command.traceparent,
          // ⚠ Null because this slice has no VERIFIED actor: JWKS token verification is not
          //   built, and reading a name out of a request header is the `x-user-id` that
          //   critical-rules #4 forbids. An unverified actor in a journal that decides
          //   thousands of euros is worse than an absent one.
          actorId: null,
        },
        occurredAt,
      );
    });

    return { showId, messageId };
  }
}
