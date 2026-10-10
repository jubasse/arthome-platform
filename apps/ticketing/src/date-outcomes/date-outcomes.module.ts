import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { DateOutcomeSweeper } from './date-outcome-sweeper.js';
import { SettleDateOutcomesHandler } from './settle-date-outcomes.handler.js';
import { NoWaitlistOutcomeHook, WaitlistOutcomeHook } from './waitlist-outcome-hook.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactionsModule } from '../ticketing-transactions.js';

/** The sweeper process's settlement of a date's cancellation or interruption. */
@Module({
  imports: [TicketingTransactionsModule],
  providers: [
    SettleDateOutcomesHandler,
    DateOutcomeSweeper,
    { provide: WaitlistOutcomeHook, useClass: NoWaitlistOutcomeHook },
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class DateOutcomesModule {}
