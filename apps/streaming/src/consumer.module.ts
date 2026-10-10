import { ConsumerHostModule } from '@arthome-platform/messaging/nest';
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { applyStreamingMessage } from './consumed-messages.js';
import { dataSource } from './data-source.js';
import { DevicesConsumerModule } from './devices/devices-consumer.module.js';
import { EntitlementConsumerModule } from './entitlement/entitlement-consumer.module.js';
import { RunConsumerModule } from './run/run-consumer.module.js';
import { SERVICE } from './service.js';

/** Every topic the consumer reads. KafkaJS will not subscribe to an empty list. */
export const CONSUMED_TOPICS: readonly string[] = [
  'arthome.ticketing.date_sales',
  'arthome.ticketing.account',
  'arthome.catalog.date',
  'arthome.identity.device',
];

/** The consumer process: the commands it dispatches and what they need, no HTTP module. */
@Module({
  imports: [
    TypeOrmModule.forRoot(dataSource.options),
    CqrsModule.forRoot(),
    ConsumerHostModule.forRoot({
      service: SERVICE,
      topics: CONSUMED_TOPICS,
      apply: applyStreamingMessage,
    }),
    EntitlementConsumerModule,
    RunConsumerModule,
    DevicesConsumerModule,
  ],
})
export class ConsumerModule {}
