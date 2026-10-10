import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { EndPriorityWindowsHandler } from './end-priority-windows.handler.js';
import { PriorityWindowSweeper } from './priority-window-sweeper.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactionsModule } from '../ticketing-transactions.js';

/** The sweeper process's end of each priority window. */
@Module({
  imports: [TicketingTransactionsModule],
  providers: [
    EndPriorityWindowsHandler,
    PriorityWindowSweeper,
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class PriorityWindowModule {}
