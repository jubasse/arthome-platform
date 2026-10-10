import {
  outcomeEndsWaitlist,
  WaitlistEntryState,
  type DateOutcome,
  type Instant,
} from '@arthome/core';

import type { TicketingTransaction } from '../ticketing-transactions.js';

/**
 * D-083's window's end, when due at `now`, under the date's row: the pool's rest on public sale, each
 *   notified entry `converted` or else `lapsed`, the count down by them. On a date an outcome ended
 *   they are `closed` instead (D-096), which the hook would have made them. False when not due, or,
 *   with `skipLocked`, when another transaction holds the row.
 */
export async function endDuePriorityWindow(
  { manager, dateSales, waitlistEntries }: TicketingTransaction,
  dateId: string,
  now: Instant,
  { skipLocked }: { readonly skipLocked: boolean },
): Promise<boolean> {
  const [claimed] = await manager.query<{ outcome: DateOutcome | null }[]>(
    `SELECT outcome FROM date_sales
      WHERE date_id = $1 AND priority_until <= $2
        FOR UPDATE${skipLocked ? ' SKIP LOCKED' : ''}`,
    [dateId, new Date(now)],
  );
  if (claimed === undefined) return false;
  const { outcome } = claimed;
  const entriesEnded = await waitlistEntries.endNotified(
    dateId,
    outcome !== null && outcomeEndsWaitlist(outcome)
      ? WaitlistEntryState.CLOSED
      : WaitlistEntryState.LAPSED,
    now,
  );
  await dateSales.endPriorityWindow(dateId, entriesEnded);
  return true;
}
