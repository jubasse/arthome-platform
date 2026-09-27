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

import { ArtistsModule } from './artists/artists.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { dataSource } from './data-source.js';
import { DatesModule } from './dates/dates.module.js';
import { EDGE_PROVIDERS } from './edge-providers.js';
import { PublicModule } from './public/public.module.js';
import { SearchModule } from './search/search.module.js';
import { VenuesModule } from './venues/venues.module.js';

@Module({
  controllers: [HealthController],
  imports: [
    TypeOrmModule.forRoot(dataSource.options),
    CqrsModule.forRoot(),
    CatalogModule,
    VenuesModule,
    DatesModule,
    PublicModule,
    ArtistsModule,
    SearchModule,
  ],
  providers: [
    ...EDGE_PROVIDERS,
    {
      provide: READINESS_CHECKS,
      inject: [DataSource],
      useFactory: (dataSource: DataSource): ReadinessCheck[] => [
        () => checkDatabaseReachable(dataSource),
        () => checkReplicationSlot(dataSource, outboxSlotName(Service.CATALOG)),
        () => checkPublicationScope(dataSource, outboxSlotName(Service.CATALOG)),
        () => checkOutboxRetention(dataSource),
      ],
    },
  ],
})
export class AppModule {}
