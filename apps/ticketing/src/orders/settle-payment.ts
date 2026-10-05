import { v7 as uuidv7 } from 'uuid';

import { RefundReason, seatCancelDeadline, type Instant } from '@arthome/core';

import { drawFreeSeatCodes } from './seat-codes.js';
import type { SeatOrder } from './seat-order.aggregate.js';
import type { TicketingTransaction } from '../ticketing-transactions.js';

/**
 * A move of the date's counters kept for the end of the transaction: the hot row stays locked from
 *   its statement to the commit, which adr-ticketing.md §2 budgets for tx A's alone.
 */
export type PendingCounterMove = () => Promise<void>;

/**
 * A payment the provider confirmed, from tx B or from its webhook (HANDOVER §0h, §0k): the seats
 *   are created from the hold, taken again when the hold is gone, or, none left, the money is owed
 *   back. The order is loaded, under its lock, before its hold; the caller saves it, writes its
 *   events, and runs the counter move it is handed last. Only D-082's retake runs at once, since
 *   whether it takes decides between paying and refunding.
 */
export async function settleConfirmedPayment(
  { manager, holds, dateSales }: TicketingTransaction,
  order: SeatOrder,
  intentRef: string,
  now: Instant,
  traceparent: string | null,
): Promise<PendingCounterMove | null> {
  if (!order.acceptsPayment) return null;
  const { holdId, dateId, quantity } = order.snapshot;
  const hold = await holds.findById(holdId);
  let pending: PendingCounterMove | null = null;
  if (hold?.isActive === true) {
    hold.consume(now);
    await holds.save(hold);
    pending = () => dateSales.sellHeldSeats(dateId, quantity);
  } else if (!(await dateSales.takeAndSellSeats(dateId, quantity, now))) {
    order.oweRefund(RefundReason.HOLD_EXPIRED_CAPACITY_LOST, intentRef, now);
    // Its `order.refunded` is written later, maybe by another process: the trace goes with the debt.
    await manager.query('UPDATE seat_order SET refund_traceparent = $2 WHERE id = $1', [
      order.snapshot.id,
      traceparent,
    ]);
    return null;
  }
  const sales = await dateSales.findUnlocked(dateId);
  const startsAt = sales?.snapshot.startsAt ?? null;
  const cancelDeadline = startsAt === null ? null : seatCancelDeadline(startsAt);
  const codes = await drawFreeSeatCodes(manager, quantity);
  order.pay(
    intentRef,
    codes.map((code) => ({ id: uuidv7(), code, cancelDeadline })),
    now,
  );
  return pending;
}
