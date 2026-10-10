import { Injectable } from '@nestjs/common';

import type { Instant } from '@arthome/core';

import type { TicketingTransaction } from '../ticketing-transactions.js';

/**
 * D-096: a cancellation or an interruption ends the date's waiting list, called once per date by
 *   the settlement pass, in a transaction of its own that holds the date's settlement row. Its
 *   implementation locks the date's row first, then the entries (HANDOVER §0n), and is idempotent:
 *   a pass that fails after it calls it again. Never called on a postponement.
 */
export abstract class WaitlistOutcomeHook {
  public abstract endWaitlist(
    transaction: TicketingTransaction,
    dateId: string,
    now: Instant,
  ): Promise<void>;
}

/** Until the waiting list exists (T5, PT3 replaces this binding). */
@Injectable()
export class NoWaitlistOutcomeHook extends WaitlistOutcomeHook {
  public endWaitlist(): Promise<void> {
    return Promise.resolve();
  }
}
