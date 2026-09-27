import { ShowUpdatedSchema } from '@arthome-platform/events';
import { RefusalException, refusalForStatus } from '@arthome-platform/http-edge';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { HttpStatus, Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import type { EntityManager } from 'typeorm';

import type { Clock } from '@arthome/core';

import { Show } from './show.entity.js';
import { UpdateShow } from './update-show.command.js';
import { writeCatalogEvent } from '../catalog-events.js';
import { CatalogTransactions } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { projectShowCopy } from '../public/date-detail-projection.js';
import { WIRE_LANGUAGE_DEPENDENCY, wireLocalizedTexts } from '../wire.js';

@CommandHandler(UpdateShow)
export class UpdateShowHandler implements ICommandHandler<UpdateShow> {
  public constructor(
    private readonly transactions: CatalogTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute(command: UpdateShow): Promise<{ showId: string }> {
    await this.transactions.run(({ manager }) => this.updateIn(manager, command));
    return { showId: command.showId };
  }

  /** ShowUpdated carries every field it names at its new value: a consumer replaces them. */
  private async updateIn(
    manager: EntityManager,
    { showId, changes, traceparent }: UpdateShow,
  ): Promise<void> {
    const show = await manager.findOneBy(Show, { id: showId });
    if (show === null) {
      throw new RefusalException(HttpStatus.NOT_FOUND, refusalForStatus(HttpStatus.NOT_FOUND));
    }

    const next = {
      genre_ids: changes.genreIds === undefined ? show.genre_ids : [...changes.genreIds],
      tag_ids: changes.tagIds === undefined ? show.tag_ids : [...changes.tagIds],
      language_dependency: changes.languageDependency ?? show.language_dependency,
      media: changes.media ?? show.media,
      title: changes.title ?? show.title,
      synopsis: changes.synopsis ?? show.synopsis,
    };
    await manager.update(Show, { id: show.id }, next);
    await projectShowCopy(manager, { id: show.id, ...next });

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
            title: wireLocalizedTexts(next.title),
            synopsis: wireLocalizedTexts(next.synopsis),
          }),
        ),
        traceparent,
      },
      occurredAt,
    );
  }
}
