import { Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import { HOLD_EXPIRY_BATCH } from '@arthome/core';

import { ExpireDueHolds } from './expire-due-holds.command.js';
import { SweeperLoop } from '../sweeper-loop.js';

/** adr-ticketing.md §6: every second. */
export const HOLD_EXPIRY_SWEEP_EVERY_MS = 1_000;

/** Returns the capacity of the holds nobody paid, in the sweeper process, Postgres alone. */
@Injectable()
export class HoldExpirySweeper extends SweeperLoop {
  protected readonly logger = new Logger(HoldExpirySweeper.name);

  public constructor(private readonly commands: CommandBus) {
    super(HOLD_EXPIRY_SWEEP_EVERY_MS, HOLD_EXPIRY_BATCH);
  }

  protected pass(): Promise<number> {
    return this.commands.execute(new ExpireDueHolds());
  }
}
