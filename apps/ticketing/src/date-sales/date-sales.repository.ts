import type { DateSales } from './date-sales.aggregate.js';

/**
 * The hot row's counters move by conditional statements, never by a load and a save
 *   (adr-ticketing.md §3, §11): each counts its move on `availability_moves` in the same statement.
 */
export abstract class DateSalesRepository {
  /** Under the row's lock to the commit, so two writes of one date run one after the other. */
  public abstract findById(dateId: string): Promise<DateSales | null>;

  /**
   * Without any lock, for a purchase: a lock here would be held across application code, at the
   *   moment the row is busiest. Nothing it reads may be written back but through `takeSeats`.
   */
  public abstract findUnlocked(dateId: string): Promise<DateSales | null>;

  /**
   * Conditioned on the version it was loaded at: a change committed since is refused with core's
   *   `STATE_CONFLICT`, naming the current version. One it did not load is inserted.
   */
  public abstract save(sales: DateSales): Promise<void>;

  /**
   * The hold's one statement: false, and nothing taken, when the date is not on sale or has fewer
   *   seats left. `sales` has decided the hold (`holdSeats`).
   */
  public abstract takeSeats(sales: DateSales, quantity: number): Promise<boolean>;

  /** A paid hold's seats, already out of `seats_available`, counted sold. */
  public abstract sellHeldSeats(dateId: string, quantity: number): Promise<void>;

  /** A hold's seats back on sale: released, or expired. */
  public abstract returnHeldSeats(dateId: string, quantity: number): Promise<void>;

  /**
   * A payment whose hold is gone takes its seats again and sells them in one statement (D-082):
   *   false, and nothing taken, when the date is not on sale or has fewer left.
   */
  public abstract takeAndSellSeats(dateId: string, quantity: number): Promise<boolean>;
}
