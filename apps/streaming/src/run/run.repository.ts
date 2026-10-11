import type { Run } from './run.aggregate.js';

/**
 * The port: domain types only, one transaction's, from `StreamingTransaction`. Every load takes
 *   the run's row, then its open incident's (HANDOVER §0's lock order: run, incident, key).
 */
export abstract class RunRepository {
  /** Under the row's lock to the commit, so two commands on one run run one after the other. */
  public abstract findByDate(dateId: string): Promise<Run | null>;

  public abstract findById(runId: string): Promise<Run | null>;

  public abstract findByStreamPath(streamPath: string): Promise<Run | null>;

  /** A sweeper pass's claim: null when another transaction holds the row (`SKIP LOCKED`). */
  public abstract claim(runId: string): Promise<Run | null>;

  /** False when the date has a run already: `ON CONFLICT DO NOTHING`, never a 23505. */
  public abstract add(run: Run): Promise<boolean>;

  /**
   * The state columns conditioned on the version it was loaded at (core's `STATE_CONFLICT` on a
   *   change committed since), its incident, and `afterGracePeriod` by a statement of its own. A
   *   reused incident id is refused `STATE_CONFLICT` too.
   */
  public abstract save(run: Run): Promise<void>;
}
