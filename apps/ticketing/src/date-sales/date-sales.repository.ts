import type { DateSales } from './date-sales.aggregate.js';

export abstract class DateSalesRepository {
  /** Under the row's lock to the commit, so two writes of one date run one after the other. */
  public abstract findById(dateId: string): Promise<DateSales | null>;

  /**
   * Conditioned on the version it was loaded at: a change committed since is refused with core's
   *   `STATE_CONFLICT`, naming the current version. One it did not load is inserted.
   */
  public abstract save(sales: DateSales): Promise<void>;
}
