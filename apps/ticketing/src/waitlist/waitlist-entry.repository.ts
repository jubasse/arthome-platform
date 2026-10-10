import type { Instant, WaitlistEntryState } from '@arthome/core';

import type { WaitlistEntry } from './waitlist-entry.aggregate.js';

/**
 * The port. Every write is made under the date's row, locked first (HANDOVER §0p): the one lock that
 *   orders a join against a tier opening and a window's end.
 */
export abstract class WaitlistEntryRepository {
  /** Under the entry's lock to the commit. */
  public abstract findByAccount(dateId: string, accountId: string): Promise<WaitlistEntry | null>;

  /** Without a lock: the purchase and the quote read whether their buyer may draw on the pool. */
  public abstract stateOf(dateId: string, accountId: string): Promise<WaitlistEntryState | null>;

  /** Conditioned on the version it was loaded at; one it did not load is inserted. */
  public abstract save(entry: WaitlistEntry): Promise<void>;

  /**
   * A tier opening: every entry on the list notified, those already notified keeping the instant
   *   they were first told, so a purchase made in the window extended still converts them. The
   *   accounts named, by account id.
   */
  public abstract notifyAll(dateId: string, now: Instant): Promise<string[]>;

  /**
   * Each notified entry `converted` when its account paid an order on the date since it was told,
   *   else `otherwise`; how many ended.
   */
  public abstract endNotified(
    dateId: string,
    otherwise: typeof WaitlistEntryState.LAPSED | typeof WaitlistEntryState.CLOSED,
    now: Instant,
  ): Promise<number>;

  /** D-096: every waiting entry `closed`; how many. */
  public abstract closeWaiting(dateId: string, now: Instant): Promise<number>;
}
