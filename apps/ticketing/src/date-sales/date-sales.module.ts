import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { DateSalesController } from './date-sales.controller.js';
import { GetDateTicketsPaneHandler } from './get-date-tickets-pane.handler.js';
import { OpenCapacityTierHandler } from './open-capacity-tier.handler.js';
import { SetDatePricesHandler } from './set-date-prices.handler.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactionsModule } from '../ticketing-transactions.js';

/** The studio's side of a date's sale, in the API process. */
@Module({
  imports: [TicketingTransactionsModule],
  controllers: [DateSalesController],
  providers: [
    GetDateTicketsPaneHandler,
    OpenCapacityTierHandler,
    SetDatePricesHandler,
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class DateSalesModule {}
