import type { SeatHold } from './seat-hold.aggregate.js';

export abstract class SeatHoldRepository {
  /** Under the row's lock to the commit; a caller holding the order locks it first. */
  public abstract findById(holdId: string): Promise<SeatHold | null>;

  /** Conditioned on the version it was loaded at; one it did not load is inserted. */
  public abstract save(hold: SeatHold): Promise<void>;
}
