import { Injectable } from '@nestjs/common';

import { WaitlistEntryState, type Instant } from '@arthome/core';

import { WaitlistOutcomeHook } from '../date-outcomes/waitlist-outcome-hook.js';
import type { TicketingTransaction } from '../ticketing-transactions.js';

/**
 * D-096 under the settlement row: the date's row first, then the entries. The pool goes on sale
 *   (the sale is closed, so nothing buys it), waiting entries are `closed`, notified ones
 *   `converted` when their account bought in the window, else `closed`, and the count is 0. A
 *   rerun finds nothing to move; a window already ended by the sweeper leaves only the waiting.
 */
@Injectable()
export class WaitlistEndingHook extends WaitlistOutcomeHook {
  public async endWaitlist(
    { dateSales, waitlistEntries }: TicketingTransaction,
    dateId: string,
    now: Instant,
  ): Promise<void> {
    if ((await dateSales.findById(dateId)) === null) return;
    await waitlistEntries.endNotified(dateId, WaitlistEntryState.CLOSED, now);
    await waitlistEntries.closeWaiting(dateId, now);
    await dateSales.closeWaitlist(dateId);
  }
}
