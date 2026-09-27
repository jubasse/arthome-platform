import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { AvailabilityPublisher } from './availability-publisher.js';
import { PublishDueAvailabilityHandler } from './publish-due-availability.handler.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactionsModule } from '../ticketing-transactions.js';

/** The sweeper process's publisher of `availability_changed`. */
@Module({
  imports: [TicketingTransactionsModule],
  providers: [
    PublishDueAvailabilityHandler,
    AvailabilityPublisher,
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class AvailabilityPublisherModule {}
