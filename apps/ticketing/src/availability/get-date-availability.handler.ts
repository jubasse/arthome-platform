import { notFound, PerishableResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { availabilityValidUntil, type Clock } from '@arthome/core';

import { dateAvailabilityOf, type DateAvailability } from './date-availability.js';
import { GetDateAvailability } from './get-date-availability.query.js';
import { CLOCK } from '../clock.js';
import { DateSalesRow } from '../date-sales/date-sales.entity.js';

/**
 * Read live off the row: `refreshDateAvailability` is the truth at command time, the event the
 *   hint (adr-ticketing.md §5). Only a sale on sale is served: one not open yet, or closed by a
 *   cancellation or an interruption, answers 404 rather than seats nobody can buy.
 */
@QueryHandler(GetDateAvailability)
export class GetDateAvailabilityHandler implements IQueryHandler<GetDateAvailability> {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute({
    dateId,
  }: GetDateAvailability): Promise<PerishableResponse<DateAvailability>> {
    const row = await this.dataSource.manager.findOneBy(DateSalesRow, { date_id: dateId });
    if (row?.on_sale !== true) throw notFound();
    return new PerishableResponse(
      dateAvailabilityOf(row),
      availabilityValidUntil(this.clock.now()),
    );
  }
}
