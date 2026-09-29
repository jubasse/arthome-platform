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

  /** The hold's one statement, once `sales` decided it: false, nothing taken, when short. */
  public abstract takeSeats(sales: DateSales, quantity: number): Promise<boolean>;

  public abstract sellHeldSeats(dateId: string, quantity: number): Promise<void>;

  public abstract returnHeldSeats(dateId: string, quantity: number): Promise<void>;

  /** A payment whose hold is gone takes and sells its seats in one statement (D-082). */
  public abstract takeAndSellSeats(dateId: string, quantity: number): Promise<boolean>;
}
