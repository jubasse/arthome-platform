import type { PerformanceDate } from './performance-date.aggregate.js';

/** The date and its publication: two rows, one aggregate, loaded and saved together (D-085). */
export abstract class PerformanceDateRepository {
  public abstract findById(id: string): Promise<PerformanceDate | null>;

  /**
   * Both rows, conditioned on the version the date was loaded at: a change committed since is
   *   refused. A date it did not load is a draft's, inserted with its publication.
   */
  public abstract save(date: PerformanceDate): Promise<void>;
}
