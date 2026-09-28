import type { Instant } from '@arthome/core';

import type { OrderFailure, SeatOrder } from './seat-order.aggregate.js';
import type { TicketingTransaction } from '../ticketing-transactions.js';

/**
 * An order whose payment failed or was abandoned: failed, and its hold given back with its seats if
 *   still active. Nothing when the order no longer waits for its payment. The order is loaded, under
 *   its lock, before its hold; the caller saves it and writes its events.
 */
export async function failUnpaidOrder(
  { holds, dateSales }: TicketingTransaction,
  order: SeatOrder,
  failure: OrderFailure,
  now: Instant,
): Promise<void> {
  if (!order.fail(failure, now)) return;
  const hold = await holds.findById(order.snapshot.holdId);
  if (hold?.isActive !== true) return;
  hold.release(now);
  await holds.save(hold);
  await dateSales.returnHeldSeats(hold.snapshot.dateId, hold.snapshot.quantity);
}
