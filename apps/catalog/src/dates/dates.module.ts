import { OutboxEvent } from '@arthome-platform/messaging';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SystemClock } from '@arthome/core';

import { DatesController } from './dates.controller.js';
import { DatesService } from './dates.service.js';
import { PerformanceDate } from './performance-date.entity.js';
import { PublicationChecklistFact } from './publication-checklist-fact.entity.js';
import { Publication } from './publication.entity.js';
import { Show } from '../catalog/show.entity.js';
import { CLOCK } from '../clock.js';
import { Venue } from '../venues/venue.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PerformanceDate,
      Publication,
      PublicationChecklistFact,
      Show,
      Venue,
      OutboxEvent,
    ]),
  ],
  controllers: [DatesController],
  providers: [DatesService, { provide: CLOCK, useValue: new SystemClock() }],
})
export class DatesModule {}
