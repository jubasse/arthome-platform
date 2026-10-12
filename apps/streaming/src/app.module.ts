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

import type { Clock } from '@arthome/core';

import { CLOCK } from './clock.js';
import { dataSource } from './data-source.js';
import { EDGE_PROVIDERS } from './edge-providers.js';
import { MediaModule } from './media/media.module.js';
import { MediaServerModule } from './media-server/media-server.module.js';
import { PlaybackModule } from './playback/playback.module.js';
import { ProgressModule } from './progress/progress.module.js';
import {
  checkOrphanRecordings,
  checkReplayAssetsFailed,
  checkRoomsIdle,
  loggedWhenDegraded,
} from './replay-asset/replay-asset-checks.js';
import { RunModule } from './run/run.module.js';
import { SERVICE } from './service.js';

/**
 * The API process. Readiness fails on the database alone; the slot, the publication, the outbox
 *   retention, the failed replay assets, the orphan recordings and the idle rooms answer `degraded`,
 *   since a stopped connector must delay publishing, not take the API out of rotation. `MediaModule`
 *   binds the fake or MediaMTX, both refused in production, so the API does not boot there.
 */
@Module({
  controllers: [HealthController],
  imports: [
    TypeOrmModule.forRoot(dataSource.options),
    CqrsModule.forRoot(),
    MediaModule,
    RunModule,
    MediaServerModule,
    PlaybackModule,
    ProgressModule,
  ],
  providers: [
    ...EDGE_PROVIDERS,
    {
      provide: READINESS_CHECKS,
      inject: [DataSource, CLOCK],
      useFactory: (dataSource: DataSource, clock: Clock): ReadinessCheck[] => [
        () => checkDatabaseReachable(dataSource),
        () => checkReplicationSlot(dataSource, outboxSlotName(SERVICE)),
        () => checkPublicationScope(dataSource, outboxSlotName(SERVICE)),
        () => checkOutboxRetention(dataSource),
        loggedWhenDegraded(() => checkReplayAssetsFailed(dataSource), clock),
        loggedWhenDegraded(() => checkOrphanRecordings(dataSource), clock),
        loggedWhenDegraded(() => checkRoomsIdle(dataSource, clock), clock),
      ],
    },
  ],
})
export class AppModule {}
