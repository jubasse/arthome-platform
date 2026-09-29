import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { ExpireDueHoldsHandler } from './expire-due-holds.handler.js';
import { HoldExpirySweeper } from './hold-expiry-sweeper.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactionsModule } from '../ticketing-transactions.js';

/** The sweeper process's hold expiry. */
@Module({
  imports: [TicketingTransactionsModule],
  providers: [
    ExpireDueHoldsHandler,
    HoldExpirySweeper,
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class HoldExpiryModule {}
