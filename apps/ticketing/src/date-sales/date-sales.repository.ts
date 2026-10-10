import type { Instant } from '@arthome/core';

import type { DateSales } from './date-sales.aggregate.js';

/**
 * The hot row's counters move by conditional statements, never by a load and a save
 *   (adr-ticketing.md §3, §11), each counting its move on `availability_moves`.
 */
export abstract class DateSalesRepository {
  /** Under the row's lock to the commit, so two writes of one date run one after the other. */
  public abstract findById(dateId: string): Promise<DateSales | null>;

  /** Without a lock: a purchase must hold none across application code. */
  public abstract findUnlocked(dateId: string): Promise<DateSales | null>;

  /**
   * Conditioned on the version it was loaded at: a change committed since is refused with core's
   *   `STATE_CONFLICT`, naming the current version. One it did not load is inserted.
   */
  public abstract save(sales: DateSales): Promise<void>;

  /**
   * The hold's one statement, once `sales` decided it: false, nothing taken, when short or past its
   *   end by time at `now`.
   */
  public abstract takeSeats(sales: DateSales, quantity: number, now: Instant): Promise<boolean>;

  /**
   * The hold's statement for a buyer notified into the window: the pool first, then the public
   *   seats, the pool only while the window is open at `now`; the hold records the pool seats it
   *   drew in the same statement. False, nothing taken, as `takeSeats`.
   */
  public abstract takeSeatsFromPool(
    sales: DateSales,
    holdId: string,
    quantity: number,
    now: Instant,
  ): Promise<boolean>;

  public abstract sellHeldSeats(dateId: string, quantity: number): Promise<void>;

  /** A hold's pool seats go back to the pool while the window is open at `now`, else on sale. */
  public abstract returnHeldSeats(dateId: string, seats: HeldSeats, now: Instant): Promise<void>;

  /**
   * Sold seats back on sale at once (D-093), counted as a move so a date sold out and back is
   *   published at once; false, nothing moved, when fewer were sold.
   */
  public abstract releaseSoldSeats(dateId: string, quantity: number): Promise<boolean>;

  /** A payment whose hold is gone takes and sells its seats in one statement (D-082). */
  public abstract takeAndSellSeats(
    dateId: string,
    quantity: number,
    now: Instant,
    fromPool: boolean,
  ): Promise<boolean>;

  /** A join or a leave, under the row `findById` locked; the version does not move. */
  public abstract moveWaitlistCount(sales: DateSales, by: 1 | -1): Promise<void>;

  /** The window's end: the pool's rest on public sale, the entries ended off the count. */
  public abstract endPriorityWindow(dateId: string, entriesEnded: number): Promise<void>;

  /** D-096: the pool on sale, the window and the count cleared; false when nothing was left. */
  public abstract closeWaitlist(dateId: string): Promise<boolean>;
}

export interface HeldSeats {
  readonly quantity: number;
  /** Of `quantity`, the seats drawn from the priority pool. */
  readonly poolSeats: number;
}
