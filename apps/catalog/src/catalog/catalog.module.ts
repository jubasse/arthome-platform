import { OutboxEvent } from '@arthome-platform/messaging';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SystemClock } from '@arthome/core';

import { CatalogController } from './catalog.controller.js';
import { PublishShowService } from './publish-show.service.js';
import { Show } from './show.entity.js';
import { UpdateShowService } from './update-show.service.js';
import { CLOCK } from '../clock.js';

@Module({
  // `OutboxEvent` is registered alongside the business entity because both are
  // written through the same transaction manager. It is not a repository this
  // service injects — `writeOutboxEvent` takes the manager it is handed.
  imports: [TypeOrmModule.forFeature([Show, OutboxEvent])],
  controllers: [CatalogController],
  providers: [
    PublishShowService,
    UpdateShowService,
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class CatalogModule {}
