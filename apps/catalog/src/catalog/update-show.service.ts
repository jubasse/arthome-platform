import { ShowUpdatedSchema } from '@arthome-platform/events';
import { RefusalException, refusalForStatus } from '@arthome-platform/http-edge';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { Bilingual, Clock, LanguageDependency, MediaSet } from '@arthome/core';

import { Show } from './show.entity.js';
import { writeCatalogEvent } from '../catalog-events.js';
import { CLOCK } from '../clock.js';
import { WIRE_LANGUAGE_DEPENDENCY } from '../wire.js';

export interface UpdateShowCommand {
  readonly showId: string;
  readonly genreIds?: readonly string[];
  readonly tagIds?: readonly string[];
  readonly languageDependency?: LanguageDependency;
  readonly media?: MediaSet;
  readonly title?: Bilingual;
  readonly synopsis?: Bilingual;
  readonly traceparent: string | null;
}

@Injectable()
export class UpdateShowService {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * ShowUpdated carries the four fields a consumer indexes, each at its new value, and only
   * when one of them changed: the copy is catalog's own and travels in no event.
   */
  public async update(command: UpdateShowCommand): Promise<{ showId: string }> {
    await this.dataSource.transaction(async (manager) => {
      const show = await manager.findOneBy(Show, { id: command.showId });
      if (show === null) {
        throw new RefusalException(HttpStatus.NOT_FOUND, refusalForStatus(HttpStatus.NOT_FOUND));
      }

      const next = {
        genre_ids: command.genreIds === undefined ? show.genre_ids : [...command.genreIds],
        tag_ids: command.tagIds === undefined ? show.tag_ids : [...command.tagIds],
        language_dependency: command.languageDependency ?? show.language_dependency,
        media: command.media ?? show.media,
        title: command.title ?? show.title,
        synopsis: command.synopsis ?? show.synopsis,
      };
      await manager.update(Show, { id: show.id }, next);

      const indexedFieldChanged =
        command.genreIds !== undefined ||
        command.tagIds !== undefined ||
        command.languageDependency !== undefined ||
        command.media !== undefined;
      if (!indexedFieldChanged) return;

      const occurredAt = new Date(this.clock.now());
      await writeCatalogEvent(
        manager,
        {
          type: 'catalog.show.updated.v1',
          key: show.id,
          payload: toBinary(
            ShowUpdatedSchema,
            create(ShowUpdatedSchema, {
              showId: show.id,
              genreIds: next.genre_ids,
              tagIds: next.tag_ids,
              languageDependency: WIRE_LANGUAGE_DEPENDENCY[next.language_dependency],
              media: { wide: [...next.media.wide], poster: [...next.media.poster] },
              occurredAt: timestampFromDate(occurredAt),
            }),
          ),
          traceparent: command.traceparent,
        },
        occurredAt,
      );
    });
    return { showId: command.showId };
  }
}
