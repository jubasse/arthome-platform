import type { BeforeApplicationShutdown, Logger, OnApplicationBootstrap } from '@nestjs/common';

/**
 * The sweeper's loops. A loop rather than `@Interval`: a pass never overlaps the previous one, and
 *   the shutdown awaits the pass in flight. Every replica may run it, since `SKIP LOCKED` hands each
 *   pass its own rows, and a missed tick loses nothing: what is due is in the database.
 */
export abstract class SweeperLoop implements OnApplicationBootstrap, BeforeApplicationShutdown {
  protected abstract readonly logger: Logger;
  private stopping = false;
  private wake: () => void = () => undefined;
  private running: Promise<void> = Promise.resolve();

  protected constructor(
    private readonly everyMs: number,
    private readonly batch: number,
  ) {}

  public onApplicationBootstrap(): void {
    this.running = this.loop();
  }

  /** Before any `onApplicationShutdown`, so the pass in flight commits before the pool closes. */
  public async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.wake();
    await this.running;
  }

  /** How many rows the pass handled: a full batch means more are due, and the next runs at once. */
  protected abstract pass(): Promise<number>;

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let handled = 0;
      try {
        handled = await this.pass();
      } catch (error) {
        // The next pass retries what this one left due; nothing else is owed to it.
        this.logger.error(error instanceof Error ? error.stack : String(error));
      }
      if (handled < this.batch) await this.pause();
    }
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.everyMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
