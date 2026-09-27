import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { Brackets } from 'typeorm';

import { AVAILABILITY_PUBLISH_MIN_INTERVAL_SECONDS, type Clock } from '@arthome/core';

import { availabilityChanged } from './availability-changed.js';
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

/** Dates claimed per pass: each row stays locked until the pass commits. */
export const AVAILABILITY_PUBLISH_BATCH = 100;

/**
 * adr-ticketing.md §5: one `availability_changed` per moved date, with its latest figures, at most
 *   every `AVAILABILITY_PUBLISH_MIN_INTERVAL_SECONDS` while it keeps moving, and at once when it
 *   sells out or comes back. `SKIP LOCKED`: two publishers claim disjoint dates, and a date a
 *   command holds waits for the next pass rather than stalling this one. Only a sale that opened
 *   is published; a draft's moves wait for its opening, which moves it too, and a closing
 *   publishes a last time, offering no seat.
 */
@CommandHandler(PublishDueAvailability)
export class PublishDueAvailabilityHandler implements ICommandHandler<PublishDueAvailability> {
  public constructor(
    private readonly transactions: TicketingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute(): Promise<number> {
    return this.transactions.run(async ({ manager }) => {
      const now = this.clock.now();
      const quietSince = new Date(
        Date.parse(now) - AVAILABILITY_PUBLISH_MIN_INTERVAL_SECONDS * 1_000,
      );
      const due = await manager
        .createQueryBuilder(DateSalesRow, 'sales')
        .where('sales.availability_dirty_since IS NOT NULL')
        .andWhere('sales.prices_locked_at IS NOT NULL')
        .andWhere(
          new Brackets((when) =>
            when
              .where('sales.availability_published_at IS NULL')
              .orWhere('sales.availability_published_at <= :quietSince', { quietSince })
              // Sold out, or back from it, against what was published last. The value published
              //   is core's (`availabilityOf`); this only finds the candidates.
              .orWhere(
                '(sales.seats_available = 0 OR NOT sales.on_sale) IS DISTINCT FROM sales.availability_published_sold_out',
              ),
          ),
        )
        .orderBy('sales.availability_published_at', 'ASC', 'NULLS FIRST')
        .limit(AVAILABILITY_PUBLISH_BATCH)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      for (const row of due) {
        const figures = offeredFiguresOf(row);
        await writeTicketingEvent(
          manager,
          availabilityChanged(row.date_id, row.channel_id, figures, now),
          new Date(now),
        );
        await manager.update(
          DateSalesRow,
          { date_id: row.date_id },
          {
            availability_dirty_since: null,
            availability_published_at: new Date(now),
            availability_published_sold_out: figures.soldOut,
          },
        );
      }
      return due.length;
    });
  }
}
