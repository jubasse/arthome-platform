import { runIdempotently, type MemorisedResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import {
  DateOutcome,
  outcomeWithdrawsReplay,
  type Clock,
  type OutcomeDeclaration,
} from '@arthome/core';

import { DeclareOutcome, type DeclaredOutcome } from './declare-outcome.command.js';
import type { DeclareOutcomeBody } from './declare-outcome.schema.js';
import { freeDateSlug } from './free-date-slug.js';
import { loadDate } from './load-date.js';
import { recordDateEvents } from './record-date-events.js';
import { CatalogTransactions, type CatalogTransaction } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
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
    const { manager, dates, replays } = transaction;
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
    date.declareOutcome(body.expectedVersion, declaration, body.message, { slugAtNewStart, now });
    // D-092: no replay, partial or not, even one already online. Before the live's end there is
    //   none yet, and the end opens none for this outcome.
    const replay = outcomeWithdrawsReplay(declaration.outcome)
      ? await replays.findByDate(dateId)
      : null;
    const withdrawn = replay?.withdraw(now) === true ? replay : null;

    await dates.save(date);
    if (withdrawn !== null) await replays.save(withdrawn);
    const events = [...date.getUncommittedEvents(), ...(withdrawn?.getUncommittedEvents() ?? [])];
    await recordDateEvents(manager, events, {
      origin: this.publicWebOrigin,
      show,
      venue,
      traceparent,
    });
    return { outcome: declaration.outcome, declaredAt: now };
  }
}
