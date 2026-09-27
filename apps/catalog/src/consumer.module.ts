import { ConsumerHostModule } from '@arthome-platform/messaging';
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Service } from '@arthome/core';

import { dataSource } from './data-source.js';
import { applyChecklistMessage } from './dates/checklist-consumer.js';
import { ChecklistConsumerModule } from './dates/checklist-consumer.module.js';

/** The facts the publication checklist projects (data-model.md §2.3), all keyed by date id. */
export const SOURCE_TOPICS = [
  'arthome.ticketing.date_sales',
  'arthome.streaming.run',
  'arthome.chat.date',
];

/** The consumer process: the command it dispatches and what that needs, no HTTP module. */
@Module({
  imports: [
    TypeOrmModule.forRoot(dataSource.options),
    CqrsModule.forRoot(),
    ChecklistConsumerModule,
    ConsumerHostModule.forRoot({
      service: Service.CATALOG,
      topics: SOURCE_TOPICS,
      apply: applyChecklistMessage,
    }),
  ],
})
export class ConsumerModule {}
