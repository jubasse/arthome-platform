import { notFound, PerishableResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { availabilityValidUntil, earliest, type Clock, type Instant } from '@arthome/core';

import { salesClosed } from './purchase-refusals.js';
import { QuoteSeat } from './quote-seat.query.js';
import { seatQuoteViewOf, type SeatQuoteView } from './seat-quote-view.js';
import { CLOCK } from '../clock.js';
import { tierPricesOf } from '../date-sales/date-sales-figures.js';
import { DateSalesRow } from '../date-sales/date-sales.entity.js';
import { seatQuoteOf } from '../date-sales/seat-quote.js';
import { lateEntryOf, salesEndedBy } from '../date-sales/seat-sales-window.js';

/**
 * Read off the row, as `refreshDateAvailability` is, and composed by the rule `purchaseSeat` verifies
 *   its expected total against. Past its end by time it answers `order.sales_closed` as the
 *   purchase does; a date not on sale, or a tier it does not sell, has nothing to quote. Once the
 *   live started it says so (`lateEntry`, D-089). Valid as long as the prices it read, and no later
 *   than the start or the end, where what it says changes.
 */
@QueryHandler(QuoteSeat)
export class QuoteSeatHandler implements IQueryHandler<QuoteSeat> {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute({ dateId, body }: QuoteSeat): Promise<PerishableResponse<SeatQuoteView>> {
    const now = this.clock.now();
    const row = await this.dataSource.manager.findOneBy(DateSalesRow, { date_id: dateId });
    const salesEndAt = row?.sales_end_at?.toISOString() ?? null;
    if (salesEndAt !== null && salesEndedBy(salesEndAt, now)) throw salesClosed(salesEndAt);
    if (row?.on_sale !== true) throw notFound();
    const quote = seatQuoteOf(tierPricesOf(row), body.tier, body.quantity);
    if (quote === null) throw notFound();
    const startsAt = row.starts_at?.toISOString() ?? null;
    const lateEntry = lateEntryOf(startsAt, now);
    const nextChange: Instant | null = lateEntry?.salesEndAt ?? startsAt;
    const validUntil =
      nextChange === null
        ? availabilityValidUntil(now)
        : earliest(availabilityValidUntil(now), nextChange);
    return new PerishableResponse(seatQuoteViewOf(quote, validUntil, lateEntry), validUntil);
  }
}
