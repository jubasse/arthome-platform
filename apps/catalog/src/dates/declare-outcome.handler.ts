import type { MemorisedResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import { DateOutcome, type Clock, type OutcomeDeclaration } from '@arthome/core';

import { asConflict } from './conflict.js';
import { DeclareOutcome, type DeclaredOutcome } from './declare-outcome.command.js';
import type { DeclareOutcomeBody } from './declare-outcome.schema.js';
import { freeDateSlug } from './free-date-slug.js';
import { loadDate } from './load-date.js';
import { recordDateEvents } from './record-date-events.js';
import { CatalogTransactions, type CatalogTransaction } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { runIdempotently } from '../idempotency/idempotency.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

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
    transaction: CatalogTransaction,
    { dateId, body, traceparent }: DeclareOutcome,
  ): Promise<DeclaredOutcome> {
    const { manager, dates } = transaction;
    const { date, show, venue } = await loadDate(transaction, dateId);

    const now = this.clock.now();
    const declaration = declarationOf(body);
    const movedTo = declaration.rescheduledTo;
    const slugAtNewStart =
      movedTo === null
        ? null
        : await freeDateSlug(
            manager,
            { id: dateId, show_id: date.snapshot.showId },
            movedTo,
            venue.time_zone,
            now,
          );
    await asConflict(() =>
      date.declareOutcome(body.expectedVersion, declaration, body.message, { slugAtNewStart, now }),
    );

    await asConflict(() => dates.save(date));
    await recordDateEvents(manager, date.getUncommittedEvents(), {
      origin: this.publicWebOrigin,
      show,
      venue,
      traceparent,
    });
    return { outcome: declaration.outcome, declaredAt: now };
  }
}
