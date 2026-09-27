import { ConsumerHostModule } from '@arthome-platform/messaging';
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Service } from '@arthome/core';

import { dataSource } from './data-source.js';
import { applyCatalogDateMessage } from './date-sales/catalog-date-messages.js';
import { CatalogFactsModule } from './date-sales/catalog-facts.module.js';

/** Keyed by `date_id` (events.md §3): a date's facts arrive in the order catalog committed them. */
export const CATALOG_DATE_TOPIC = 'arthome.catalog.date';

/** The consumer process: the command it dispatches and what that needs, no HTTP module. */
@Module({
  imports: [
    TypeOrmModule.forRoot(dataSource.options),
    CqrsModule.forRoot(),
    CatalogFactsModule,
    ConsumerHostModule.forRoot({
      service: Service.TICKETING,
      topics: [CATALOG_DATE_TOPIC],
      apply: applyCatalogDateMessage,
    }),
  ],
})
export class ConsumerModule {}
