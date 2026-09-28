import { Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import { PublishDueAvailability } from './publish-due-availability.command.js';
import { AVAILABILITY_PUBLISH_BATCH } from './publish-due-availability.handler.js';
import { SweeperLoop } from '../sweeper-loop.js';

/** How often the publisher looks: the delay a sell-out waits before it is published. */
export const AVAILABILITY_SWEEP_EVERY_MS = 1_000;

@Injectable()
export class AvailabilityPublisher extends SweeperLoop {
  protected readonly logger = new Logger(AvailabilityPublisher.name);

  public constructor(private readonly commands: CommandBus) {
    super(AVAILABILITY_SWEEP_EVERY_MS, AVAILABILITY_PUBLISH_BATCH);
  }

  protected pass(): Promise<number> {
    return this.commands.execute(new PublishDueAvailability());
  }
}
