import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AvailabilityPublisherModule } from './availability/availability-publisher.module.js';
import { dataSource } from './data-source.js';
import { DateOutcomesModule } from './date-outcomes/date-outcomes.module.js';
import { SalesClosingModule } from './date-sales/sales-closing.module.js';
import { HoldExpiryModule } from './orders/hold-expiry.module.js';
import { PriorityWindowModule } from './waitlist/priority-window.module.js';

/**
 * The sweeper process: the work that runs on a clock against Postgres alone, the availability
 *   publisher, the hold expiry, the closing of sales whose time is over, the settlement of a date's
 *   cancellation or interruption and the end of each waiting list's priority window. Neither Kafka nor Redis can stop it, which is why it is
 *   not the consumer's process: expired holds must give their capacity back while the broker is
 *   down.
 */
@Module({
  imports: [
    TypeOrmModule.forRoot(dataSource.options),
    CqrsModule.forRoot(),
    AvailabilityPublisherModule,
    HoldExpiryModule,
    SalesClosingModule,
    DateOutcomesModule,
    PriorityWindowModule,
  ],
})
export class SweeperModule {}
