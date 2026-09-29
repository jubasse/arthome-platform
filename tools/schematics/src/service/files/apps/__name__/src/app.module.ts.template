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

import { dataSource } from './data-source.js';
import { EDGE_PROVIDERS } from './edge-providers.js';
import { SERVICE } from './service.js';

/**
 * The API process. Readiness fails on the database alone; the slot, the publication and the outbox
 *   retention answer `degraded`, since a stopped connector must delay publishing, not take the API
 *   out of rotation.
 */
@Module({
  controllers: [HealthController],
  imports: [TypeOrmModule.forRoot(dataSource.options), CqrsModule.forRoot()],
  providers: [
    ...EDGE_PROVIDERS,
    {
      provide: READINESS_CHECKS,
      inject: [DataSource],
      useFactory: (dataSource: DataSource): ReadinessCheck[] => [
        () => checkDatabaseReachable(dataSource),
        () => checkReplicationSlot(dataSource, outboxSlotName(SERVICE)),
        () => checkPublicationScope(dataSource, outboxSlotName(SERVICE)),
        () => checkOutboxRetention(dataSource),
      ],
    },
  ],
})
export class AppModule {}
