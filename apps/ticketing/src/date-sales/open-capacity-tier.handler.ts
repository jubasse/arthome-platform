import {
  notFound,
  runIdempotentlyVersioned,
  type MemorisedResponse,
} from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import type { Clock } from '@arthome/core';

import { OpenCapacityTier, type OpenedCapacityTier } from './open-capacity-tier.command.js';
import { readDateSalesPane } from './read-date-sales-pane.js';
import { recordDateSalesEvents } from './record-date-sales-events.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactions, type TicketingTransaction } from '../ticketing-transactions.js';
import { endDuePriorityWindow } from '../waitlist/priority-window-end.js';
import { writeWaitlistNotified } from '../waitlist/waitlist-notified.js';

/**
 * One transaction (adr-ticketing.md §9): the date's row locked first, the tier, then, when it opens
 *   or extends a window, every entry on the list notified and named in `waitlist.notified` rows. A
 *   join waits on the date's row, so it commits before the marking or sees the window after it. A
 *   window past its end that the sweeper has not reached yet is ended first: extended, it would
 *   carry its pool and its lapsed entries into the new one.
 */
@CommandHandler(OpenCapacityTier)
export class OpenCapacityTierHandler implements ICommandHandler<OpenCapacityTier> {
  public constructor(
    private readonly transactions: TicketingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute(command: OpenCapacityTier): Promise<MemorisedResponse<OpenedCapacityTier>> {
    return this.transactions.run((transaction) =>
      runIdempotentlyVersioned(transaction.manager, command.idempotency, this.clock, () =>
        this.openIn(transaction, command),
      ),
    );
  }

  private async openIn(
    transaction: TicketingTransaction,
    { dateId, body, traceparent }: OpenCapacityTier,
  ): Promise<{ readonly data: OpenedCapacityTier; readonly version: number }> {
    const { manager, dateSales, waitlistEntries } = transaction;
    const now = this.clock.now();
    await endDuePriorityWindow(transaction, dateId, now, { skipLocked: false });
    const sales = await dateSales.findById(dateId);
    if (sales === null) throw notFound();

    const priorityUntil = sales.openCapacityTier(
      body.expectedVersion,
      body.additionalCapacity,
      body.notifyWaitlist,
      now,
    );
    await dateSales.save(sales);
    await recordDateSalesEvents(manager, sales.getUncommittedEvents(), { traceparent });
    let accountIds: string[] = [];
    if (priorityUntil !== null) {
      accountIds = await waitlistEntries.notifyAll(dateId, now);
      await writeWaitlistNotified(manager, { dateId, accountIds, priorityUntil }, now, traceparent);
    }

    const pane = await readDateSalesPane(manager, dateId, now);
    if (pane === null) throw new Error(`date sales ${dateId} vanished inside its transaction`);
    return {
      data: {
        sales: pane,
        waitlistNotified: accountIds.length,
        ...(priorityUntil !== null && { priorityUntil }),
      },
      version: sales.snapshot.version,
    };
  }
}
