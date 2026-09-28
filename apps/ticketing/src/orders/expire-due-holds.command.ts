import { Command } from '@nestjs/cqrs';

/** adr-ticketing.md §6: the expired active holds a pass takes at most. */
export const HOLD_EXPIRY_BATCH = 500;

/** One pass of the hold expiry; answers how many holds it expired. */
export class ExpireDueHolds extends Command<number> {
  public constructor(public readonly batch: number = HOLD_EXPIRY_BATCH) {
    super();
  }
}
