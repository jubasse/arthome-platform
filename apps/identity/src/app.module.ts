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
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Service } from '@arthome/core';

import { AuthModule } from './auth/auth.module.js';
import { dataSource } from './data-source.js';
import { EDGE_PROVIDERS } from './edge-providers.js';

@Module({
  controllers: [HealthController],
  imports: [TypeOrmModule.forRoot(dataSource.options), AuthModule],
  providers: [
    ...EDGE_PROVIDERS,
    {
      provide: READINESS_CHECKS,
      inject: [DataSource],
      useFactory: (source: DataSource): ReadinessCheck[] => [
        () => checkDatabaseReachable(source),
        () => checkReplicationSlot(source, outboxSlotName(Service.IDENTITY)),
        () => checkPublicationScope(source, outboxSlotName(Service.IDENTITY)),
        () => checkOutboxRetention(source),
      ],
    },
  ],
})
export class AppModule {}
