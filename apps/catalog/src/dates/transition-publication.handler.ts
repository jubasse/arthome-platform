import type { MemorisedResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import type { Clock } from '@arthome/core';

import { asConflict } from './conflict.js';
import { writeDateIntegrationEvents } from './date-integration-events.js';
import { dateNotFound } from './date-records.js';
import { publicationView, satisfiedChecklistItems, type PublicationView } from './date-sheet.js';
import { freeDateSlug } from './free-date-slug.js';
import { PublicationChecklistFact } from './publication-checklist-fact.entity.js';
import { TransitionPublication } from './transition-publication.command.js';
import { Show } from '../catalog/show.entity.js';
import { CatalogTransactions, type CatalogTransaction } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { runIdempotently } from '../idempotency/idempotency.js';
import { projectDateEvents } from '../public/date-detail-projection.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { Venue } from '../venues/venue.entity.js';

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
        this.transitionIn(transaction, command),
      ),
    );
  }

  private async transitionIn(
    { manager, dates, publications }: CatalogTransaction,
    { dateId, body, traceparent }: TransitionPublication,
  ): Promise<PublicationView> {
    const date = await dates.findById(dateId);
    if (date === null) throw dateNotFound();
    const publication = await publications.findByDateId(dateId);
    if (publication === null) throw new Error(`date ${dateId} has no publication`);
    const { showId, venueId, startsAt, slug } = date.snapshot;
    const show = await manager.findOneByOrFail(Show, { id: showId });
    const venue = await manager.findOneByOrFail(Venue, { id: venueId });
    const projectedFacts = await manager.findBy(PublicationChecklistFact, { date_id: dateId });
    const satisfied = satisfiedChecklistItems(show, projectedFacts);

    const now = this.clock.now();
    const command = {
      to: body.to,
      expectedVersion: body.expectedVersion,
      acknowledgedPromise: body.acknowledgedPromiseCode,
    };
    const published = asConflict(() => publication.transition(command, { satisfied, now }));
    if (published) {
      const free =
        slug ??
        (await freeDateSlug(
          manager,
          { id: dateId, show_id: showId },
          startsAt,
          venue.time_zone,
          now,
        ));
      date.makePublic(free, show.runtime_min, now);
    }

    await publications.save(publication);
    if (published) await dates.save(date);
    const events = [...publication.getUncommittedEvents(), ...date.getUncommittedEvents()];
    await projectDateEvents(manager, events, { show, venue });
    await writeDateIntegrationEvents(manager, events, {
      origin: this.publicWebOrigin,
      show,
      venue,
      traceparent,
    });
    return publicationView(publication.snapshot, satisfied);
  }
}
