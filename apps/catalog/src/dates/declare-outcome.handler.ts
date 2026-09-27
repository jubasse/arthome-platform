import type { MemorisedResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import { DateOutcome, type Clock, type OutcomeDeclaration } from '@arthome/core';

import { asConflict } from './conflict.js';
import { writeDateIntegrationEvents } from './date-integration-events.js';
import { dateNotFound } from './date-records.js';
import { DeclareOutcome, type DeclaredOutcome } from './declare-outcome.command.js';
import type { DeclareOutcomeBody } from './declare-outcome.schema.js';
import { freeDateSlug } from './free-date-slug.js';
import { Show } from '../catalog/show.entity.js';
import { CatalogTransactions, type CatalogTransaction } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { runIdempotently } from '../idempotency/idempotency.js';
import { projectDateEvents } from '../public/date-detail-projection.js';
import { retireSlugsMovedFrom } from '../public/slug-aliases.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { Venue } from '../venues/venue.entity.js';

function declarationOf(body: DeclareOutcomeBody): OutcomeDeclaration {
  if (body.outcome !== DateOutcome.POSTPONED) return { outcome: body.outcome, rescheduledTo: null };
  // The schema requires the instant for a postponement; a caller bypassing it is a defect.
  if (body.rescheduledTo === null) throw new Error('a postponement without rescheduledTo');
  // `InstantIn` accepts an instant without its milliseconds: one spelling from here on.
  return {
    outcome: DateOutcome.POSTPONED,
    rescheduledTo: new Date(body.rescheduledTo).toISOString(),
  };
}

@CommandHandler(DeclareOutcome)
export class DeclareOutcomeHandler implements ICommandHandler<DeclareOutcome> {
  public constructor(
    private readonly transactions: CatalogTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUBLIC_WEB_ORIGIN) private readonly publicWebOrigin: string,
  ) {}

  public execute(command: DeclareOutcome): Promise<MemorisedResponse<DeclaredOutcome>> {
    return this.transactions.run((transaction) =>
      runIdempotently(transaction.manager, command.idempotency, this.clock, () =>
        this.declareIn(transaction, command),
      ),
    );
  }

  private async declareIn(
    { manager, dates, publications }: CatalogTransaction,
    { dateId, body, traceparent }: DeclareOutcome,
  ): Promise<DeclaredOutcome> {
    const date = await dates.findById(dateId);
    if (date === null) throw dateNotFound();
    const publication = await publications.findByDateId(dateId);
    if (publication === null) throw new Error(`date ${dateId} has no publication`);
    const { showId, venueId } = date.snapshot;
    const show = await manager.findOneByOrFail(Show, { id: showId });
    const venue = await manager.findOneByOrFail(Venue, { id: venueId });

    asConflict(() => publication.advanceVersionFrom(body.expectedVersion));
    const now = this.clock.now();
    const declaration = declarationOf(body);
    const movedTo = declaration.rescheduledTo;
    const slugAtNewStart =
      movedTo === null
        ? null
        : await freeDateSlug(
            manager,
            { id: dateId, show_id: showId },
            movedTo,
            venue.time_zone,
            now,
          );
    asConflict(() =>
      date.declareOutcome(declaration, body.message, {
        publicationState: publication.snapshot.state,
        slugAtNewStart,
        now,
      }),
    );

    await publications.save(publication);
    await dates.save(date);
    const events = date.getUncommittedEvents();
    await retireSlugsMovedFrom(manager, events);
    await projectDateEvents(manager, events);
    await writeDateIntegrationEvents(manager, events, {
      origin: this.publicWebOrigin,
      show,
      venue,
      traceparent,
    });
    return { outcome: declaration.outcome, declaredAt: now };
  }
}
