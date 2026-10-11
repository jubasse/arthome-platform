import { readRedisUrl } from '@arthome-platform/config';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { dataSource } from './data-source.js';
import { PROVIDER_CALL_QUEUE_PREFIX } from './payments/provider-call-queues.js';
import { ProviderCallQueuesModule } from './payments/provider-call-queues.module.js';

/**
 * The worker process: every call ticketing owes the payment provider, a refund or an intent's
 *   cancellation, made from BullMQ's queues (HANDOVER §0m). It alone holds Redis: the API stays
 *   ready on the database alone, and a drain of refunds shares neither its event loop nor its
 *   replicas.
 */
@Module({
  imports: [
    TypeOrmModule.forRoot(dataSource.options),
    CqrsModule.forRoot(),
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: { url: readRedisUrl() },
        prefix: PROVIDER_CALL_QUEUE_PREFIX,
      }),
    }),
    ProviderCallQueuesModule,
  ],
})
export class WorkerModule {}
