import { Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import { CloseEndedSales, SALES_CLOSING_BATCH } from './close-ended-sales.command.js';
import { SweeperLoop } from '../sweeper-loop.js';

const SALES_CLOSING_EVERY_MS = 1_000;

/** Ends the sales whose time is over, in the sweeper process beside the other two loops. */
@Injectable()
export class SalesClosingSweeper extends SweeperLoop {
  protected readonly logger = new Logger(SalesClosingSweeper.name);

  public constructor(private readonly commands: CommandBus) {
    super(SALES_CLOSING_EVERY_MS, SALES_CLOSING_BATCH);
  }

  protected pass(): Promise<number> {
    return this.commands.execute(new CloseEndedSales());
  }
}
