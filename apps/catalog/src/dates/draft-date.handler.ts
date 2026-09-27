import { schemaInvalidException, type MemorisedResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import type { Clock } from '@arthome/core';

import { dateSheet, type DateSheet } from './date-sheet.js';
import { DraftDate } from './draft-date.command.js';
import { PerformanceDate } from './performance-date.aggregate.js';
import { recordDateEvents } from './record-date-events.js';
import { Show } from '../catalog/show.entity.js';
import { CatalogTransactions, type CatalogTransaction } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { runIdempotently } from '../idempotency/idempotency.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { Venue } from '../venues/venue.entity.js';

@CommandHandler(DraftDate)
export class DraftDateHandler implements ICommandHandler<DraftDate> {
  public constructor(
    private readonly transactions: CatalogTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUBLIC_WEB_ORIGIN) private readonly publicWebOrigin: string,
  ) {}

  public execute(command: DraftDate): Promise<MemorisedResponse<DateSheet>> {
    return this.transactions.run((transaction) =>
      runIdempotently(transaction.manager, command.idempotency, this.clock, () =>
        this.draftIn(transaction, command),
      ),
    );
  }

  /**
   * The date and its publication in one transaction, by decision rather than by accident: the
   * contract creates a draft "with its publication and its checklist" (openapi/studio.yaml).
   */
  private async draftIn(
    { manager, dates }: CatalogTransaction,
    { channelId, body, traceparent }: DraftDate,
  ): Promise<DateSheet> {
    const show = await manager.findOneBy(Show, { id: body.showId });
    // Another channel's show is refused like a missing one: it is not this channel's to schedule.
    if (show?.channel_id !== channelId) {
      throw schemaInvalidException([{ path: ['showId'] }]);
    }
    const venue = await manager.findOneBy(Venue, { id: body.venueId });
    if (venue === null) throw schemaInvalidException([{ path: ['venueId'] }]);
    // A retry carries its Idempotency-Key and was replayed before this; the same id under a new
    // key is a client that reused an identifier.
    if ((await dates.findById(body.dateId)) !== null) {
      throw schemaInvalidException([{ path: ['dateId'] }]);
    }

    const date = PerformanceDate.draft(
      {
        id: body.dateId,
        showId: show.id,
        venueId: venue.id,
        channelId,
        // `InstantIn` accepts an instant without its milliseconds: one spelling from here on.
        startsAt: new Date(body.startsAt).toISOString(),
        runtimeMin: show.runtime_min,
        replayPolicy: body.replayPolicy,
        replayWindowHours: body.replayWindowHours,
      },
      this.clock.now(),
    );
    await dates.save(date);
    await recordDateEvents(manager, date.getUncommittedEvents(), {
      origin: this.publicWebOrigin,
      show,
      venue,
      traceparent,
    });
    return dateSheet(
      { date: date.snapshot, publication: date.publication, show, venue, projectedFacts: [] },
      this.publicWebOrigin,
    );
  }
}
