import { OutboxEvent } from '@arthome-platform/messaging';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CatalogController } from './catalog.controller.js';
import { PublishShowService } from './publish-show.service.js';
import { Show } from './show.entity.js';

@Module({
  // `OutboxEvent` is registered alongside the business entity because both are
  // written through the same transaction manager. It is not a repository this
  // service injects — `writeOutboxEvent` takes the manager it is handed.
  imports: [TypeOrmModule.forFeature([Show, OutboxEvent])],
  controllers: [CatalogController],
  providers: [PublishShowService],
})
export class CatalogModule {}
