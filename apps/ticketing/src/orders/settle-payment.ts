import { v7 as uuidv7 } from 'uuid';

import {
  DateOutcome,
  RefundReason,
  refundReasonOnDate,
  seatCancelDeadline,
  type Instant,
} from '@arthome/core';

import { drawFreeSeatCodes } from './seat-codes.js';
import type { SeatOrder } from './seat-order.aggregate.js';
import { recordRefundTraceparent } from '../payments/refund-ledger.js';
import type { TicketingTransaction } from '../ticketing-transactions.js';
import { drawsOnPriorityPool } from '../waitlist/priority-pool.js';

/**
 * A move of the date's counters kept for the end of the transaction: the hot row stays locked from
 *   its statement to the commit, which adr-ticketing.md §2 budgets for tx A's alone.
 */
export type PendingCounterMove = () => Promise<void>;

/**
 * A payment the provider confirmed, from tx B or from its webhook (HANDOVER §0h, §0k, §0n): the
 *   seats are created from the hold, taken again when the hold is gone, or, none left, the money is
 *   owed back. On a date a cancellation closed no seat is given: the hold goes back and the money
 *   is owed back `date_cancelled` (D-097). The order is loaded, under its lock, before its hold; the
 *   caller saves it, writes its events, and runs the counter move it is handed last. Only D-082's
 *   retake runs at once, since whether it takes decides between paying and refunding.
 */
export async function settleConfirmedPayment(
  transaction: TicketingTransaction,
  order: SeatOrder,
  intentRef: string,
  now: Instant,
  traceparent: string | null,
): Promise<PendingCounterMove | null> {
  if (!order.acceptsPayment) return null;
  const { holds, dateSales } = transaction;
  const { holdId, dateId, quantity, accountId } = order.snapshot;
  const sales = await dateSales.findUnlocked(dateId);
  const outcome = sales?.snapshot.outcome ?? null;
  const hold = await holds.findById(holdId);
  if (outcome === DateOutcome.CANCELLED) {
    let returned: PendingCounterMove | null = null;
    if (hold?.isActive === true) {
      hold.release(now);
      await holds.save(hold);
      returned = () => dateSales.returnHeldSeats(dateId, hold.snapshot, now);
    }
    await owePaymentBack(transaction, order, outcome, intentRef, now, traceparent);
    return returned;
  }
  let pending: PendingCounterMove | null = null;
  if (hold?.isActive === true) {
    hold.consume(now);
    await holds.save(hold);
    pending = () => dateSales.sellHeldSeats(dateId, quantity);
  } else if (
    !(await dateSales.takeAndSellSeats(
      dateId,
      quantity,
      now,
      await drawsOnPriorityPool(transaction, sales, accountId, now),
    ))
  ) {
    // Read again: a cancellation committed since the first read is what refused the statement.
    const outcomeNow = (await dateSales.findUnlocked(dateId))?.snapshot.outcome ?? null;
    await owePaymentBack(transaction, order, outcomeNow, intentRef, now, traceparent);
    return null;
  }
  const startsAt = sales?.snapshot.startsAt ?? null;
  const cancelDeadline = startsAt === null ? null : seatCancelDeadline(startsAt);
  const codes = await drawFreeSeatCodes(transaction.manager, quantity);
  order.pay(
    intentRef,
    codes.map((code) => ({ id: uuidv7(), code, cancelDeadline })),
    now,
  );
  return pending;
}

/**
 * All of it, with no seat: D-082's capacity lost, or `date_cancelled` on a cancelled date. The
 *   order is saved here, so its refund's row exists to take the trace.
 */
async function owePaymentBack(
  { manager, orders }: TicketingTransaction,
  order: SeatOrder,
  outcome: DateOutcome | null,
  intentRef: string,
  now: Instant,
  traceparent: string | null,
): Promise<void> {
  const refundId = order.oweUnseatedPaymentBack(
    refundReasonOnDate(outcome, RefundReason.HOLD_EXPIRED_CAPACITY_LOST),
    intentRef,
    now,
  );
  if (refundId === null) return;
  await orders.save(order);
  await recordRefundTraceparent(manager, refundId, traceparent);
}
