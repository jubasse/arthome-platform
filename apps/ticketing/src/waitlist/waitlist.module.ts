import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { GetWaitlistRegistrationHandler } from './get-waitlist-registration.handler.js';
import { JoinWaitlistHandler } from './join-waitlist.handler.js';
import { LeaveWaitlistHandler } from './leave-waitlist.handler.js';
import { WaitlistController } from './waitlist.controller.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactionsModule } from '../ticketing-transactions.js';

/** The storefront's waiting list, in the API process; its window ends in the sweeper's. */
@Module({
  imports: [TicketingTransactionsModule],
  controllers: [WaitlistController],
  providers: [
    { provide: CLOCK, useValue: new SystemClock() },
    GetWaitlistRegistrationHandler,
    JoinWaitlistHandler,
    LeaveWaitlistHandler,
  ],
})
export class WaitlistModule {}
