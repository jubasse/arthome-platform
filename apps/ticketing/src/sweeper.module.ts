import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AvailabilityPublisherModule } from './availability/availability-publisher.module.js';
import { dataSource } from './data-source.js';

/**
 * The sweeper process: the work that runs on a clock against Postgres alone. Neither Kafka nor
 *   Redis can stop it, which is why it is not the consumer's process: T3's hold expiry returns
 *   capacity here, and must go on while the broker is down.
 */
@Module({
  imports: [
    TypeOrmModule.forRoot(dataSource.options),
    CqrsModule.forRoot(),
    AvailabilityPublisherModule,
  ],
})
export class SweeperModule {}
