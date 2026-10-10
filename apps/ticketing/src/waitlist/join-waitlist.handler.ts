import { notFound, runIdempotently, type MemorisedResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { v7 as uuidv7 } from 'uuid';

import { assertWaitlistJoinable, type Clock } from '@arthome/core';

import { JoinWaitlist } from './join-waitlist.command.js';
import { recordWaitlistEntryEvents } from './record-waitlist-entry-events.js';
import { WaitlistEntry } from './waitlist-entry.aggregate.js';
import { waitlistRegistrationOf, type WaitlistRegistrationView } from './waitlist-registration.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactions, type TicketingTransaction } from '../ticketing-transactions.js';

/**
 * A state assignment (D-083): the date's row locked first, so two first joins under two keys leave
 *   one entry, the second finding the first's, and a join never slips between a tier opening's
 *   marking and its commit. An account already on the list is answered with nothing written.
 */
@CommandHandler(JoinWaitlist)
export class JoinWaitlistHandler implements ICommandHandler<JoinWaitlist> {
  public constructor(
    private readonly transactions: TicketingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute(command: JoinWaitlist): Promise<MemorisedResponse<WaitlistRegistrationView>> {
    return this.transactions.run((transaction) =>
      runIdempotently(transaction.manager, command.idempotency, this.clock, () =>
        this.joinIn(transaction, command),
      ),
    );
  }

  private async joinIn(
    { manager, dateSales, waitlistEntries }: TicketingTransaction,
    { dateId, accountId, traceparent }: JoinWaitlist,
  ): Promise<WaitlistRegistrationView> {
    const sales = await dateSales.findById(dateId);
    // Core: a date with no start sells nothing and has no list, like a sale never opened.
    const salesEndAt = sales?.snapshot.salesEndAt ?? null;
    if (sales?.snapshot.pricesLockedAt == null || salesEndAt === null) throw notFound();
    const { outcome, seatsAvailable, priorityUntil } = sales.snapshot;

    const now = this.clock.now();
    let entry = await waitlistEntries.findByAccount(dateId, accountId);
    if (entry?.isOnList !== true) {
      assertWaitlistJoinable({
        publicSeatsAvailable: seatsAvailable,
        salesEndAt,
        outcome,
        now,
      });
      if (entry === null) {
        entry = WaitlistEntry.join({ id: uuidv7(), dateId, accountId }, priorityUntil, now);
      } else {
        entry.rejoin(priorityUntil, now);
      }
      await waitlistEntries.save(entry);
      await recordWaitlistEntryEvents(manager, entry.getUncommittedEvents(), traceparent);
      await dateSales.moveWaitlistCount(sales, 1);
    }
    return waitlistRegistrationOf(entry.snapshot.state, sales.snapshot, now);
  }
}
