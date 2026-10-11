import { isPriorityWindowOpen, WaitlistEntryState, type Instant } from '@arthome/core';

import type { DateSales } from '../date-sales/date-sales.aggregate.js';
import type { TicketingTransaction } from '../ticketing-transactions.js';

export function inPriorityWindow(
  state: WaitlistEntryState | null,
  priorityUntil: Instant | null,
  now: Instant,
): boolean {
  return state === WaitlistEntryState.NOTIFIED && isPriorityWindowOpen(priorityUntil, now);
}

/**
 * Whether the account buys from the pool: notified into a window open at `now` (D-083). The entry is
 *   read unlocked, and only while a window is open; the pool's statement holds the window's end
 *   again at its own instant.
 */
export async function drawsOnPriorityPool(
  { waitlistEntries }: Pick<TicketingTransaction, 'waitlistEntries'>,
  sales: DateSales | null,
  accountId: string | null,
  now: Instant,
): Promise<boolean> {
  if (sales === null || accountId === null) return false;
  const { dateId, priorityUntil } = sales.snapshot;
  if (!isPriorityWindowOpen(priorityUntil, now)) return false;
  return inPriorityWindow(await waitlistEntries.stateOf(dateId, accountId), priorityUntil, now);
}
