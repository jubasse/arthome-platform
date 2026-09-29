import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { CloseEndedSalesHandler } from './close-ended-sales.handler.js';
import { SalesClosingSweeper } from './sales-closing-sweeper.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactionsModule } from '../ticketing-transactions.js';

@Module({
  imports: [TicketingTransactionsModule],
  providers: [
    CloseEndedSalesHandler,
    SalesClosingSweeper,
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class SalesClosingModule {}
