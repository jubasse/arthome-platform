import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { WaitlistEntryState, type Clock, type Instant } from '@arthome/core';

import { EndPriorityWindows } from './end-priority-windows.command.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * D-083's window's end (HANDOVER §0p): each window due, read through its partial index, then taken
 *   in a transaction of its own under the date's row, `SKIP LOCKED`, and left alone when a tier
 *   opening extended it since. The pool's rest goes on public sale in one move, each notified entry
 *   is `converted` or `lapsed`, and the count drops by them. No event.
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
    return this.transactions.run(async ({ manager, dateSales, waitlistEntries }) => {
      const claimed = await manager.query<unknown[]>(
        `SELECT date_id FROM date_sales
          WHERE date_id = $1 AND priority_until <= $2
            FOR UPDATE SKIP LOCKED`,
        [dateId, new Date(now)],
      );
      if (claimed.length === 0) return false;
      const entriesEnded = await waitlistEntries.endNotified(
        dateId,
        WaitlistEntryState.LAPSED,
        now,
      );
      await dateSales.endPriorityWindow(dateId, entriesEnded);
      return true;
    });
  }
}
