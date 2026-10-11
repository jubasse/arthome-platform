import { notFound, runIdempotently, type MemorisedResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import type { Clock } from '@arthome/core';

import { LeaveWaitlist, type WaitlistDepartureView } from './leave-waitlist.command.js';
import { recordWaitlistEntryEvents } from './record-waitlist-entry-events.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactions, type TicketingTransaction } from '../ticketing-transactions.js';

/** A state assignment: replayed on an entry already off the list, it succeeds and writes nothing. */
@CommandHandler(LeaveWaitlist)
export class LeaveWaitlistHandler implements ICommandHandler<LeaveWaitlist> {
  public constructor(
    private readonly transactions: TicketingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute(command: LeaveWaitlist): Promise<MemorisedResponse<WaitlistDepartureView>> {
    return this.transactions.run((transaction) =>
      runIdempotently(transaction.manager, command.idempotency, this.clock, () =>
        this.leaveIn(transaction, command),
      ),
    );
  }

  private async leaveIn(
    { manager, dateSales, waitlistEntries }: TicketingTransaction,
    { dateId, accountId, traceparent }: LeaveWaitlist,
  ): Promise<WaitlistDepartureView> {
    const sales = await dateSales.findById(dateId);
    if (sales === null) throw notFound();
    const entry = await waitlistEntries.findByAccount(dateId, accountId);
    if (entry?.leave(this.clock.now()) === true) {
      await waitlistEntries.save(entry);
      await recordWaitlistEntryEvents(manager, entry.getUncommittedEvents(), traceparent);
      await dateSales.moveWaitlistCount(sales, -1);
    }
    return { joined: false };
  }
}
