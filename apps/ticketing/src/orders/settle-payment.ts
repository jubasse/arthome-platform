import { v7 as uuidv7 } from 'uuid';

import { RefundReason, type Instant } from '@arthome/core';

import { interimSeatCancelDeadlineOf } from './seat-cancel-deadline.js';
import { drawFreeSeatCodes } from './seat-codes.js';
import type { SeatOrder } from './seat-order.aggregate.js';
import type { TicketingTransaction } from '../ticketing-transactions.js';

/**
 * A payment the provider confirmed, whether the purchase's own intent said so or its webhook: the
 *   seats are created from the hold (D-077), or taken again with the conditional decrement when the
 *   hold is gone, or, none being left, the money is owed back (D-082) and no seat exists. Never an
 *   oversold date, never money kept without a seat. The order must be loaded, under its lock,
 *   before its hold; the caller saves it and writes its events.
 */
export async function settleConfirmedPayment(
  { manager, holds, dateSales }: TicketingTransaction,
  order: SeatOrder,
  intentRef: string,
  now: Instant,
  traceparent: string | null,
): Promise<void> {
  if (!order.acceptsPayment) return;
  const { holdId, dateId, quantity } = order.snapshot;
  const hold = await holds.findById(holdId);
  if (hold?.isActive === true) {
    hold.consume(now);
    await holds.save(hold);
    await dateSales.sellHeldSeats(dateId, quantity);
  } else if (!(await dateSales.takeAndSellSeats(dateId, quantity, now))) {
    order.oweRefund(RefundReason.HOLD_EXPIRED_CAPACITY_LOST, intentRef, now);
    // Its `order.refunded` is written later, maybe by another process: the trace goes with the debt.
    await manager.query('UPDATE seat_order SET refund_traceparent = $2 WHERE id = $1', [
      order.snapshot.id,
      traceparent,
    ]);
    return;
  }
  const sales = await dateSales.findUnlocked(dateId);
  const cancelDeadline = interimSeatCancelDeadlineOf(sales?.snapshot.startsAt ?? null);
  const codes = await drawFreeSeatCodes(manager, quantity);
  order.pay(
    intentRef,
    codes.map((code) => ({ id: uuidv7(), code, cancelDeadline })),
    now,
  );
}
