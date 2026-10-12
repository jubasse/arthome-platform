import { notFound } from '@arthome-platform/http-edge';
import { Outcome, claimMessage } from '@arthome-platform/messaging';
import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import { PublicationState, type Clock } from '@arthome/core';

import { LearnReplayAssetFact, type ReplayAssetFact } from './learn-replay-asset-fact.command.js';
import { recordReplayEvents } from './record-replay-events.js';
import type { Replay } from './replay.aggregate.js';
import { CatalogTransactions } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { PublicationRow } from '../dates/publication.entity.js';

const RUN_ENDED: ReadonlySet<PublicationState> = new Set([
  PublicationState.ENDED,
  PublicationState.REPLAY_ONLINE,
]);

/** Not a refusal: a retry topic put the file ahead of its run's end, which opens the `Replay`. */
export class ReplayFactBeforeRunEnded extends Error {
  public constructor(dateId: string) {
    super(`a replay fact of date ${dateId} came before its run's end was applied`);
  }
}

/**
 * Locks the `Replay`'s row alone, never the publication's (HANDOVER §0f's lock order): the
 *   publication is read without a lock, and first, so a `run.ended` committing between the two
 *   reads shows its `Replay` to the second.
 */
@CommandHandler(LearnReplayAssetFact)
export class LearnReplayAssetFactHandler implements ICommandHandler<LearnReplayAssetFact> {
  private readonly logger = new Logger(LearnReplayAssetFactHandler.name);

  public constructor(
    private readonly transactions: CatalogTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute({ messageId, topic, fact, traceparent }: LearnReplayAssetFact): Promise<Outcome> {
    return this.transactions.run(async ({ manager, replays }) => {
      if (!(await claimMessage(manager, messageId, topic))) return Outcome.DUPLICATE;

      const publication = await manager.findOneBy(PublicationRow, { date_id: fact.dateId });
      if (publication === null) throw notFound();
      const replay = await replays.findByDate(fact.dateId);
      if (replay === null) {
        if (!RUN_ENDED.has(publication.state)) throw new ReplayFactBeforeRunEnded(fact.dateId);
        return Outcome.IGNORED;
      }

      if (!this.learn(replay, fact)) return Outcome.IGNORED;
      await replays.save(replay);
      await recordReplayEvents(manager, replay.getUncommittedEvents(), traceparent);
      return Outcome.APPLIED;
    });
  }

  private learn(replay: Replay, { ready }: ReplayAssetFact): boolean {
    if (ready === null) return replay.close(this.clock.now());
    const { closesAt } = replay.snapshot;
    if (ready.expiresAt !== null && Date.parse(ready.expiresAt) !== Date.parse(closesAt)) {
      this.logger.warn(
        `date ${replay.snapshot.dateId}: streaming expires its file at ${ready.expiresAt}, the replay closes at ${closesAt}`,
      );
    }
    return replay.learnAssetReady(ready);
  }
}
