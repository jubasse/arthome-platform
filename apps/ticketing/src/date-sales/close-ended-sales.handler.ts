import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { Clock } from '@arthome/core';

import { CloseEndedSales } from './close-ended-sales.command.js';
import { recordDateSalesEvents } from './record-date-sales-events.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * Closes the sales on sale whose end by time has passed (`salesEndOf`), each in a transaction of
 *   its own under the date's row, as a closing outcome closes one: `on_sale` false, the publisher's
 *   last publication due, a hold's statement refused from then on. The row is locked once, when
 *   nothing is sold any more.
 */
@CommandHandler(CloseEndedSales)
export class CloseEndedSalesHandler implements ICommandHandler<CloseEndedSales> {
  public constructor(
    private readonly transactions: TicketingTransactions,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute({ batch }: CloseEndedSales): Promise<number> {
    const now = this.clock.now();
    const ended = await this.dataSource.query<{ date_id: string }[]>(
      `SELECT date_id FROM date_sales
        WHERE on_sale AND sales_end_at <= $1
        ORDER BY sales_end_at
        LIMIT $2`,
      [new Date(now), batch],
    );
    let closed = 0;
    for (const { date_id } of ended) {
      const closedNow = await this.transactions.run(async ({ manager, dateSales }) => {
        const sales = await dateSales.findById(date_id);
        if (sales?.endSales(now) !== true) return false;
        await dateSales.save(sales);
        await recordDateSalesEvents(manager, sales.getUncommittedEvents(), { traceparent: null });
        return true;
      });
      if (closedNow) closed += 1;
    }
    return closed;
  }
}
