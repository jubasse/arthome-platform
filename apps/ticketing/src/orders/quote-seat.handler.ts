import { notFound, PerishableResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { availabilityValidUntil, type Clock } from '@arthome/core';

import { QuoteSeat } from './quote-seat.query.js';
import { seatQuoteViewOf, type SeatQuoteView } from './seat-quote-view.js';
import { CLOCK } from '../clock.js';
import { tierPricesOf } from '../date-sales/date-sales-figures.js';
import { DateSalesRow } from '../date-sales/date-sales.entity.js';
import { seatQuoteOf } from '../date-sales/seat-quote.js';

/**
 * Read off the row, as `refreshDateAvailability` is, and composed by the rule `purchaseSeat` verifies
 *   its expected total against. Valid as long as the prices it read: `AVAILABILITY_VALID_SECONDS`.
 *   A date not on sale, or a tier it does not sell, has nothing to quote.
 */
@QueryHandler(QuoteSeat)
export class QuoteSeatHandler implements IQueryHandler<QuoteSeat> {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute({ dateId, body }: QuoteSeat): Promise<PerishableResponse<SeatQuoteView>> {
    const row = await this.dataSource.manager.findOneBy(DateSalesRow, { date_id: dateId });
    if (row?.on_sale !== true) throw notFound();
    const quote = seatQuoteOf(tierPricesOf(row), body.tier, body.quantity);
    if (quote === null) throw notFound();
    const validUntil = availabilityValidUntil(this.clock.now());
    return new PerishableResponse(seatQuoteViewOf(quote, validUntil), validUntil);
  }
}
