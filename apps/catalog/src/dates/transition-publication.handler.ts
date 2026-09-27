import type { MemorisedResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import type { Clock } from '@arthome/core';

import { asConflict } from './conflict.js';
import { publicationView, satisfiedChecklistItems, type PublicationView } from './date-sheet.js';
import { freeDateSlug } from './free-date-slug.js';
import { loadDate } from './load-date.js';
import { PublicationChecklistFact } from './publication-checklist-fact.entity.js';
import { recordDateEvents } from './record-date-events.js';
import { TransitionPublication } from './transition-publication.command.js';
import { CatalogTransactions, type CatalogTransaction } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { runIdempotently } from '../idempotency/idempotency.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

@CommandHandler(TransitionPublication)
export class TransitionPublicationHandler implements ICommandHandler<TransitionPublication> {
  public constructor(
    private readonly transactions: CatalogTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUBLIC_WEB_ORIGIN) private readonly publicWebOrigin: string,
  ) {}

  public execute(command: TransitionPublication): Promise<MemorisedResponse<PublicationView>> {
    return this.transactions.run((transaction) =>
      runIdempotently(transaction.manager, command.idempotency, this.clock, () =>
        asConflict(() => this.transitionIn(transaction, command)),
      ),
    );
  }

  private async transitionIn(
    transaction: CatalogTransaction,
    { dateId, body, traceparent }: TransitionPublication,
  ): Promise<PublicationView> {
    const { manager, dates } = transaction;
    const { date, show, venue } = await loadDate(transaction, dateId);
    const projectedFacts = await manager.findBy(PublicationChecklistFact, { date_id: dateId });
    const satisfied = satisfiedChecklistItems(show, projectedFacts);

    const now = this.clock.now();
    const { showId, startsAt, slug } = date.snapshot;
    const freeSlug =
      slug === null
        ? await freeDateSlug(
            manager,
            { id: dateId, show_id: showId },
            startsAt,
            venue.time_zone,
            now,
          )
        : null;
    date.transitionPublication(
      {
        to: body.to,
        expectedVersion: body.expectedVersion,
        acknowledgedPromise: body.acknowledgedPromiseCode,
      },
      { satisfied, freeSlug, showRuntimeMin: show.runtime_min, now },
    );

    await dates.save(date);
    await recordDateEvents(manager, date.getUncommittedEvents(), {
      origin: this.publicWebOrigin,
      show,
      venue,
      traceparent,
    });
    return publicationView(date.publication, satisfied);
  }
}
