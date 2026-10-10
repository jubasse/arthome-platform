import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { Clock, Instant } from '@arthome/core';

import { EndPriorityWindows } from './end-priority-windows.command.js';
import { endDuePriorityWindow } from './priority-window-end.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * D-083's window's end (HANDOVER §0p): each window due, read through its partial index, then ended
 *   in a transaction of its own, `SKIP LOCKED`, and left alone when a tier opening extended it
 *   since. No event.
 */
@CommandHandler(EndPriorityWindows)
export class EndPriorityWindowsHandler implements ICommandHandler<EndPriorityWindows> {
  private readonly logger = new Logger(EndPriorityWindowsHandler.name);

  public constructor(
    private readonly transactions: TicketingTransactions,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute({ batch }: EndPriorityWindows): Promise<number> {
    const now = this.clock.now();
    const due = await this.dataSource.query<{ date_id: string }[]>(
      `SELECT date_id FROM date_sales
        WHERE priority_until <= $1
        ORDER BY priority_until
        LIMIT $2`,
      [new Date(now), batch],
    );
    let ended = 0;
    for (const { date_id } of due) {
      try {
        if (await this.endWindow(date_id, now)) ended += 1;
      } catch (error) {
        // One date that fails holds back no other; the next pass tries it again.
        this.logger.error(
          `priority window of date ${date_id} not ended`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    return ended;
  }

  private endWindow(dateId: string, now: Instant): Promise<boolean> {
    return this.transactions.run((transaction) =>
      endDuePriorityWindow(transaction, dateId, now, { skipLocked: true }),
    );
  }
}
