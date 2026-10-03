import { type Instant, type OrderState } from '@arthome/core';

import type { PaymentIntentRecord, SeatOrder } from './seat-order.aggregate.js';
import { OWED_INTENT_CANCELLATION, restartOwedCall } from '../payments/owed-calls.js';
import type { TicketingTransaction } from '../ticketing-transactions.js';

/**
 * An intent still waiting for the buyer or the bank, from tx B or its webhook. Reaching an order
 *   that failed meanwhile, it is owed a cancellation again: from its first instant, the fact, and
 *   with its attempts started over, whether the last one was made or given up on.
 */
export async function recordWaitingIntent(
  { manager }: TicketingTransaction,
  order: SeatOrder,
  intent: PaymentIntentRecord,
  state: typeof OrderState.AWAITING_ACTION | typeof OrderState.PROCESSING,
  now: Instant,
): Promise<void> {
  if (!order.recordIntent(intent, state, now)) return;
  await restartOwedCall(manager, OWED_INTENT_CANCELLATION, order.snapshot.id);
}
