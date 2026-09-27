import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AVAILABILITY_PUBLISH_MIN_INTERVAL_SECONDS, type Clock, type Instant } from '@arthome/core';

import { availabilityChanged } from './availability-changed.js';
import { DateAvailabilityPublicationRow } from './date-availability-publication.entity.js';
import { PublishDueAvailability } from './publish-due-availability.command.js';
import { CLOCK } from '../clock.js';
import {
  availabilityFiguresOf,
  type AvailabilityFigures,
} from '../date-sales/date-sales-figures.js';
import { DateSalesRow } from '../date-sales/date-sales.entity.js';
import { writeTicketingEvent } from '../ticketing-events.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/** A closed sale offers nothing: its last publication says so, whatever seats were left. */
function offeredFiguresOf(row: DateSalesRow): AvailabilityFigures {
  const figures = availabilityFiguresOf(row);
  return row.on_sale ? figures : { ...figures, seatsAvailable: 0, soldOut: true };
}

/** Dates a pass looks at; each is then published in a transaction of its own. */
export const AVAILABILITY_PUBLISH_BATCH = 100;

/**
 * The candidates: moved since their last publication, and quiet for the interval or flipped
 *   around sold out against what was published. Read without any lock: the figures are re-read
 *   and the decision taken again under the publication row's.
 */
const DUE_DATES = `
  SELECT sales.date_id
    FROM date_sales AS sales
    JOIN date_availability_publication AS publication USING (date_id)
   WHERE sales.prices_locked_at IS NOT NULL
     AND sales.availability_moves > publication.published_moves
     AND (publication.published_at IS NULL
          OR publication.published_at <= $1
          OR (sales.seats_available = 0 OR NOT sales.on_sale)
             IS DISTINCT FROM publication.published_sold_out)
   ORDER BY publication.published_at ASC NULLS FIRST
   LIMIT $2
`;

/**
 * adr-ticketing.md §5: one `availability_changed` per moved date, with its latest figures, at most
 *   every `AVAILABILITY_PUBLISH_MIN_INTERVAL_SECONDS` while it keeps moving, and at once when it
 *   sells out or comes back. It never locks `date_sales`, the row the capacity invariant serialises
 *   on: a date is claimed through its publication row, `SKIP LOCKED`, one date per short
 *   transaction, and its figures read as committed. A move committed after that read counts one
 *   more than what is recorded as published, so it is due again: none is lost. Only a sale that
 *   opened is published, and a closing a last time, offering no seat.
 */
@CommandHandler(PublishDueAvailability)
export class PublishDueAvailabilityHandler implements ICommandHandler<PublishDueAvailability> {
  public constructor(
    private readonly transactions: TicketingTransactions,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute(): Promise<number> {
    const now = this.clock.now();
    const quietSince = new Date(
      Date.parse(now) - AVAILABILITY_PUBLISH_MIN_INTERVAL_SECONDS * 1_000,
    );
    const candidates = await this.dataSource.query<{ date_id: string }[]>(DUE_DATES, [
      quietSince,
      AVAILABILITY_PUBLISH_BATCH,
    ]);
    let published = 0;
    for (const { date_id } of candidates) {
      if (await this.publishIfDue(date_id, now, quietSince)) published += 1;
    }
    return published;
  }

  private publishIfDue(dateId: string, now: Instant, quietSince: Date): Promise<boolean> {
    return this.transactions.run(async ({ manager }) => {
      const publication = await manager.findOne(DateAvailabilityPublicationRow, {
        where: { date_id: dateId },
        lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' },
      });
      if (publication === null) return false;
      const sales = await manager.findOneByOrFail(DateSalesRow, { date_id: dateId });
      const figures = offeredFiguresOf(sales);
      const due =
        BigInt(sales.availability_moves) > BigInt(publication.published_moves) &&
        (publication.published_at === null ||
          publication.published_at <= quietSince ||
          publication.published_sold_out !== figures.soldOut);
      if (!due) return false;

      await writeTicketingEvent(
        manager,
        availabilityChanged(sales.date_id, sales.channel_id, figures, now),
        new Date(now),
      );
      await manager.update(
        DateAvailabilityPublicationRow,
        { date_id: dateId },
        {
          published_moves: sales.availability_moves,
          published_at: new Date(now),
          published_sold_out: figures.soldOut,
        },
      );
      return true;
    });
  }
}
