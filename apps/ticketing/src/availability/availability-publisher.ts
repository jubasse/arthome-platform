import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import { PublishDueAvailability } from './publish-due-availability.command.js';
import { AVAILABILITY_PUBLISH_BATCH } from './publish-due-availability.handler.js';

/** How often the publisher looks: the delay a sell-out waits before it is published. */
export const AVAILABILITY_SWEEP_EVERY_MS = 1_000;

/**
 * A loop rather than `@Interval`: a pass never overlaps the previous one, and the shutdown awaits
 *   the pass in flight. Every replica may run it, since `SKIP LOCKED` hands each pass its own
 *   dates, and a missed tick loses nothing: the marks are in the database.
 */
@Injectable()
export class AvailabilityPublisher implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(AvailabilityPublisher.name);
  private stopping = false;
  private wake: () => void = () => undefined;
  private running: Promise<void> = Promise.resolve();

  public constructor(private readonly commands: CommandBus) {}

  public onApplicationBootstrap(): void {
    this.running = this.loop();
  }

  /** Before any `onApplicationShutdown`, so the pass in flight commits before the pool closes. */
  public async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.wake();
    await this.running;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let published = 0;
      try {
        published = await this.commands.execute(new PublishDueAvailability());
      } catch (error) {
        // The next pass retries what this one left marked; nothing else is owed to it.
        this.logger.error(error instanceof Error ? error.stack : String(error));
      }
      if (published < AVAILABILITY_PUBLISH_BATCH) await this.pause();
    }
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, AVAILABILITY_SWEEP_EVERY_MS);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
