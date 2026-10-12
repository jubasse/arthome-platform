import { Outcome, claimMessage } from '@arthome-platform/messaging';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import { RunState, createsReplayOnLiveEnd, type Clock, type Instant } from '@arthome/core';

import { LearnRunFact } from './learn-run-fact.command.js';
import { loadDate } from './load-date.js';
import type { PerformanceDate } from './performance-date.aggregate.js';
import { recordDateEvents } from './record-date-events.js';
import { CatalogTransactions } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { Replay } from '../replays/replay.aggregate.js';

/**
 * The live's end opens the date's `Replay` in the same transaction as the publication's move, so
 *   no `ended` date lacks the `Replay` its promise made (HANDOVER §0h): none when the date
 *   promised no replay, or its outcome took it away.
 */
function replayOpenedBy(date: PerformanceDate, liveEndedAt: Instant, now: Instant): Replay | null {
  const { id, channelId, replayPolicy, replayWindowHours, outcome } = date.snapshot;
  const windowHours = replayWindowHours ?? 0;
  if (!createsReplayOnLiveEnd(replayPolicy, windowHours, outcome)) return null;
  return Replay.open(
    { dateId: id, channelId, policy: replayPolicy, liveEndedAt, windowHours },
    now,
  );
}

@CommandHandler(LearnRunFact)
export class LearnRunFactHandler implements ICommandHandler<LearnRunFact> {
  public constructor(
    private readonly transactions: CatalogTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUBLIC_WEB_ORIGIN) private readonly publicWebOrigin: string,
  ) {}

  public execute({ messageId, topic, fact, traceparent }: LearnRunFact): Promise<Outcome> {
    return this.transactions.run(async (transaction) => {
      const { manager, dates, replays } = transaction;
      if (!(await claimMessage(manager, messageId, topic))) return Outcome.DUPLICATE;

      const { date, show, venue } = await loadDate(transaction, fact.dateId);
      const now = this.clock.now();
      const moved =
        fact.run === RunState.ON_AIR ? date.learnRunStarted(now) : date.learnRunEnded(now);
      if (!moved) return Outcome.IGNORED;

      await dates.save(date);
      const replay = fact.endedAt === null ? null : replayOpenedBy(date, fact.endedAt, now);
      if (replay !== null) await replays.save(replay);
      const events = [...date.getUncommittedEvents(), ...(replay?.getUncommittedEvents() ?? [])];
      await recordDateEvents(manager, events, {
        origin: this.publicWebOrigin,
        show,
        venue,
        traceparent,
      });
      return Outcome.APPLIED;
    });
  }
}
