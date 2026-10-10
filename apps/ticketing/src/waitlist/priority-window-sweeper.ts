import { Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import { EndPriorityWindows, PRIORITY_WINDOW_END_BATCH } from './end-priority-windows.command.js';
import { SweeperLoop } from '../sweeper-loop.js';

const PRIORITY_WINDOW_END_EVERY_MS = 1_000;

@Injectable()
export class PriorityWindowSweeper extends SweeperLoop {
  protected readonly logger = new Logger(PriorityWindowSweeper.name);

  public constructor(private readonly commands: CommandBus) {
    super(PRIORITY_WINDOW_END_EVERY_MS, PRIORITY_WINDOW_END_BATCH);
  }

  protected pass(): Promise<number> {
    return this.commands.execute(new EndPriorityWindows());
  }
}
