import { notFound } from '@arthome-platform/http-edge';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { DateSalesPane } from './date-sales-pane.js';
import { GetDateTicketsPane } from './get-date-tickets-pane.query.js';
import { readDateSalesPane } from './read-date-sales-pane.js';

/** One row, so one read: nothing to hold together. */
@QueryHandler(GetDateTicketsPane)
export class GetDateTicketsPaneHandler implements IQueryHandler<GetDateTicketsPane> {
  public constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  public async execute({ dateId }: GetDateTicketsPane): Promise<DateSalesPane> {
    const pane = await readDateSalesPane(this.dataSource.manager, dateId);
    if (pane === null) throw notFound();
    return pane;
  }
}
