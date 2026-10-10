import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { dataSource } from './data-source.js';
import { ReplayAssetSweeperModule } from './replay-asset/replay-asset-sweeper.module.js';
import { RunSweeperModule } from './run/run-sweeper.module.js';

/**
 * The sweeper process: the work that runs on a clock against Postgres alone, each pass a
 *   `SweeperLoop` provided by a feature module imported here. Neither Kafka nor Redis can stop it,
 *   which is why it is not the consumer's process.
 */
@Module({
  imports: [
    TypeOrmModule.forRoot(dataSource.options),
    CqrsModule.forRoot(),
    RunSweeperModule,
    ReplayAssetSweeperModule,
  ],
})
export class SweeperModule {}
