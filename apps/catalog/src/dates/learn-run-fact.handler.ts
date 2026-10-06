import { Outcome, claimMessage } from '@arthome-platform/messaging';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import { RunState, type Clock } from '@arthome/core';

import { LearnRunFact } from './learn-run-fact.command.js';
import { loadDate } from './load-date.js';
import { recordDateEvents } from './record-date-events.js';
import { CatalogTransactions } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

@CommandHandler(LearnRunFact)
export class LearnRunFactHandler implements ICommandHandler<LearnRunFact> {
  public constructor(
    private readonly transactions: CatalogTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUBLIC_WEB_ORIGIN) private readonly publicWebOrigin: string,
  ) {}

  public execute({ messageId, topic, fact }: LearnRunFact): Promise<Outcome> {
    return this.transactions.run(async (transaction) => {
      const { manager, dates } = transaction;
      if (!(await claimMessage(manager, messageId, topic))) return Outcome.DUPLICATE;

      const { date, show, venue } = await loadDate(transaction, fact.dateId);
      const now = this.clock.now();
      const moved =
        fact.run === RunState.ON_AIR ? date.learnRunStarted(now) : date.learnRunEnded(now);
      if (!moved) return Outcome.IGNORED;

      await dates.save(date);
      await recordDateEvents(manager, date.getUncommittedEvents(), {
        origin: this.publicWebOrigin,
        show,
        venue,
        traceparent: null,
      });
      return Outcome.APPLIED;
    });
  }
}
