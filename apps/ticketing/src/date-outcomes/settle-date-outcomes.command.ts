import { Command } from '@nestjs/cqrs';

/** Orders settled per transaction (adr-ticketing.md §8: "in batches of 500 per transaction"). */
export const DATE_OUTCOME_ORDER_BATCH = 500;

/** Dates a pass takes, each settled one batch further. */
export const DATE_OUTCOME_DATES_PER_PASS = 10;

/** One pass of the settlement; answers how many orders it settled. */
export class SettleDateOutcomes extends Command<number> {
  public constructor(
    public readonly orderBatch: number = DATE_OUTCOME_ORDER_BATCH,
    public readonly dates: number = DATE_OUTCOME_DATES_PER_PASS,
  ) {
    super();
  }
}
