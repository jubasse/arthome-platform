import { Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import { DATE_OUTCOME_ORDER_BATCH, SettleDateOutcomes } from './settle-date-outcomes.command.js';
import { SweeperLoop } from '../sweeper-loop.js';

const DATE_OUTCOME_SWEEP_EVERY_MS = 1_000;

/** Settles the dates cancelled or interrupted, in the sweeper process beside the other loops. */
@Injectable()
export class DateOutcomeSweeper extends SweeperLoop {
  protected readonly logger = new Logger(DateOutcomeSweeper.name);

  public constructor(private readonly commands: CommandBus) {
    super(DATE_OUTCOME_SWEEP_EVERY_MS, DATE_OUTCOME_ORDER_BATCH);
  }

  protected pass(): Promise<number> {
    return this.commands.execute(new SettleDateOutcomes());
  }
}
