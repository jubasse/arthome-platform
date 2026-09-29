import { Command } from '@nestjs/cqrs';

/** Sales a pass closes at most. */
export const SALES_CLOSING_BATCH = 100;

/** One pass of the sales closing; answers how many sales it closed. */
export class CloseEndedSales extends Command<number> {
  public constructor(public readonly batch: number = SALES_CLOSING_BATCH) {
    super();
  }
}
