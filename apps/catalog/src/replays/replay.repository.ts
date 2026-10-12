import type { Replay } from './replay.aggregate.js';

/** A date's `Replay`, read under its row lock to the commit. */
export abstract class ReplayRepository {
  public abstract findByDate(dateId: string): Promise<Replay | null>;

  /**
   * Conditioned on the version it was loaded at: a change committed since is refused with core's
   *   `STATE_CONFLICT`. A `Replay` it did not load is a new one, inserted.
   */
  public abstract save(replay: Replay): Promise<void>;
}
