import {
  HealthController,
  READINESS_CHECKS,
  type ReadinessCheck,
} from '@arthome-platform/http-edge';
import {
  checkDatabaseReachable,
  checkOutboxRetention,
  checkPublicationScope,
  checkReplicationSlot,
  outboxSlotName,
} from '@arthome-platform/messaging';
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Service } from '@arthome/core';

import { AvailabilityModule } from './availability/availability.module.js';
import { dataSource } from './data-source.js';
import { DateSalesModule } from './date-sales/date-sales.module.js';
import { EDGE_PROVIDERS } from './edge-providers.js';
import { OrdersModule } from './orders/orders.module.js';

/**
 * The API process: the studio's commands and pane, the storefront's availability read, and its
 *   seat quote, purchase and order.
 */
@Module({
  controllers: [HealthController],
  imports: [
    TypeOrmModule.forRoot(dataSource.options),
    CqrsModule.forRoot(),
    DateSalesModule,
    AvailabilityModule,
    OrdersModule,
  ],
  providers: [
    ...EDGE_PROVIDERS,
    {
      provide: READINESS_CHECKS,
      inject: [DataSource],
      useFactory: (dataSource: DataSource): ReadinessCheck[] => [
        () => checkDatabaseReachable(dataSource),
        () => checkReplicationSlot(dataSource, outboxSlotName(Service.TICKETING)),
        () => checkPublicationScope(dataSource, outboxSlotName(Service.TICKETING)),
        () => checkOutboxRetention(dataSource),
      ],
    },
  ],
})
export class AppModule {}
