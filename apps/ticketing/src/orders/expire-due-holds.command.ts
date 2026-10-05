import { Command } from '@nestjs/cqrs';

import { HOLD_EXPIRY_BATCH } from '@arthome/core';

/** One pass of the hold expiry; answers how many holds it expired. */
export class ExpireDueHolds extends Command<number> {
  public constructor(public readonly batch: number = HOLD_EXPIRY_BATCH) {
    super();
  }
}
