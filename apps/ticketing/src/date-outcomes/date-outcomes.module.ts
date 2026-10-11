import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { DateOutcomeSweeper } from './date-outcome-sweeper.js';
import { SettleDateOutcomesHandler } from './settle-date-outcomes.handler.js';
import { WaitlistOutcomeHook } from './waitlist-outcome-hook.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactionsModule } from '../ticketing-transactions.js';
import { WaitlistEndingHook } from '../waitlist/waitlist-ending-hook.js';

/** The sweeper process's settlement of a date's cancellation or interruption. */
@Module({
  imports: [TicketingTransactionsModule],
  providers: [
    SettleDateOutcomesHandler,
    DateOutcomeSweeper,
    { provide: WaitlistOutcomeHook, useClass: WaitlistEndingHook },
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class DateOutcomesModule {}
