import type { Credit } from './credit.aggregate.js';

/** The port: domain types only, one transaction's, from `TicketingTransaction`. */
export abstract class CreditRepository {
  /**
   * Inserts a credit just issued, after its order's lock. False, nothing written, when its order
   *   already holds a credit of that origin: one per order and origin, whatever replays it.
   */
  public abstract issue(credit: Credit): Promise<boolean>;
}
