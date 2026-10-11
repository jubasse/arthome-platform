import type { Instant } from '@arthome/core';

import type { OrderFailure, SeatOrder } from './seat-order.aggregate.js';
import type { PendingCounterMove } from './settle-payment.js';
import type { TicketingTransaction } from '../ticketing-transactions.js';

/**
 * An order whose payment failed or was abandoned: failed, and its hold given back if still active,
 *   its seats returned by the counter move the caller runs last (`PendingCounterMove`). Nothing when
 *   the order no longer waits for its payment. The order is loaded, under its lock, before its hold.
 */
export async function failUnpaidOrder(
  { holds, dateSales }: TicketingTransaction,
  order: SeatOrder,
  failure: OrderFailure,
  now: Instant,
): Promise<PendingCounterMove | null> {
  if (!order.fail(failure, now)) return null;
  const hold = await holds.findById(order.snapshot.holdId);
  if (hold?.isActive !== true) return null;
  hold.release(now);
  await holds.save(hold);
  return () => dateSales.returnHeldSeats(hold.snapshot.dateId, hold.snapshot, now);
}
