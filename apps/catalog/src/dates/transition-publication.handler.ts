import { runIdempotently, type MemorisedResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import { PublicationState, assertReplayGoesOnline, type Clock, type Instant } from '@arthome/core';

import { publicationView, satisfiedChecklistItems, type PublicationView } from './date-sheet.js';
import { freeDateSlug } from './free-date-slug.js';
import { loadDate } from './load-date.js';
import { PublicationChecklistFact } from './publication-checklist-fact.entity.js';
import { recordDateEvents } from './record-date-events.js';
import { TransitionPublication } from './transition-publication.command.js';
import { CatalogTransactions, type CatalogTransaction } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import type { Replay } from '../replays/replay.aggregate.js';
import type { ReplayRepository } from '../replays/replay.repository.js';

/**
 * `ended -> replay_online` moves the `Replay` too, or nothing: the two never diverge (HANDOVER
 *   §0h). Loaded after the publication and the show (the lock order); a date without one is
 *   refused by core all the same.
 */
async function replayPutOnline(
  replays: ReplayRepository,
  dateId: string,
  now: Instant,
): Promise<Replay> {
  const replay = await replays.findByDate(dateId);
  if (replay === null) {
    assertReplayGoesOnline(null);
    throw new Error(`date ${dateId} has no replay, and core let it go online`);
  }
  replay.goOnline(now);
  return replay;
}

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
    transaction: CatalogTransaction,
    { dateId, body, traceparent }: TransitionPublication,
  ): Promise<PublicationView> {
    const { manager, dates, replays } = transaction;
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
    const replay =
      body.to === PublicationState.REPLAY_ONLINE
        ? await replayPutOnline(replays, dateId, now)
        : null;

    await dates.save(date);
    if (replay !== null) await replays.save(replay);
    const events = [...date.getUncommittedEvents(), ...(replay?.getUncommittedEvents() ?? [])];
    await recordDateEvents(manager, events, {
      origin: this.publicWebOrigin,
      show,
      venue,
      traceparent,
    });
    return publicationView(date.publication, satisfied);
  }
}
