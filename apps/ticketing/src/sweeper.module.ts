import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AvailabilityPublisherModule } from './availability/availability-publisher.module.js';
import { dataSource } from './data-source.js';
import { HoldExpiryModule } from './orders/hold-expiry.module.js';

/**
 * The sweeper process: the work that runs on a clock against Postgres alone, the availability
 *   publisher and the hold expiry. Neither Kafka nor Redis can stop it, which is why it is not the
 *   consumer's process: expired holds must give their capacity back while the broker is down.
 */
@Module({
  imports: [
    TypeOrmModule.forRoot(dataSource.options),
    CqrsModule.forRoot(),
    AvailabilityPublisherModule,
    HoldExpiryModule,
  ],
})
export class SweeperModule {}
