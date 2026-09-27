import type { PerformanceDate } from './performance-date.aggregate.js';

export abstract class PerformanceDateRepository {
  public abstract findById(id: string): Promise<PerformanceDate | null>;

  public abstract save(date: PerformanceDate): Promise<void>;
}
