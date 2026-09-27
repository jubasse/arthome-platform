import { PerishableResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { Clock } from '@arthome/core';

import {
  availabilityValidUntil,
  dateAvailabilityOf,
  type DateAvailability,
} from './date-availability.js';
import { GetDateAvailability } from './get-date-availability.query.js';
import { CLOCK } from '../clock.js';
import { DateSalesRow } from '../date-sales/date-sales.entity.js';
import { notFound } from '../refusals.js';

/**
 * Read live off the row: `refreshDateAvailability` is the truth at command time, the event the
 *   hint (adr-ticketing.md §5). A date whose sale never opened is not public yet: 404.
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
    if (row?.prices_locked_at == null) throw notFound();
    return new PerishableResponse(
      dateAvailabilityOf(row),
      availabilityValidUntil(this.clock.now()),
    );
  }
}
