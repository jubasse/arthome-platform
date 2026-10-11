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
import { PaymentWebhooksModule } from './payments/payment-webhooks.module.js';
import { PaymentWorkerModule } from './payments/payment-worker.module.js';
import { SeatsModule } from './seats/seats.module.js';
import { WaitlistModule } from './waitlist/waitlist.module.js';

/**
 * The API process: the studio's commands and pane, the storefront's availability read, its seat
 *   quote, purchase and order, a seat's cancellation and refund, the payment provider's webhooks
 *   and the worker that applies them.
 */
@Module({
  controllers: [HealthController],
  imports: [
    TypeOrmModule.forRoot(dataSource.options),
    CqrsModule.forRoot(),
    DateSalesModule,
    AvailabilityModule,
    OrdersModule,
    PaymentWebhooksModule,
    PaymentWorkerModule,
    SeatsModule,
    WaitlistModule,
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
