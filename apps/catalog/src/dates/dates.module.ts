import { readPublicWebOrigin } from '@arthome-platform/config';
import { OutboxEvent } from '@arthome-platform/messaging';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SystemClock } from '@arthome/core';

import { DatesController } from './dates.controller.js';
import { DeclareOutcomeHandler } from './declare-outcome.handler.js';
import { DraftDateHandler } from './draft-date.handler.js';
import { GetDateSheetHandler } from './get-date-sheet.handler.js';
import { PerformanceDateRow } from './performance-date.entity.js';
import { PublicationChecklistFact } from './publication-checklist-fact.entity.js';
import { PublicationRow } from './publication.entity.js';
import { TransitionPublicationHandler } from './transition-publication.handler.js';
import { Show } from '../catalog/show.entity.js';
import { CatalogTransactions } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { Venue } from '../venues/venue.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PerformanceDateRow,
      PublicationRow,
      PublicationChecklistFact,
      Show,
      Venue,
      OutboxEvent,
    ]),
  ],
  controllers: [DatesController],
  providers: [
    CatalogTransactions,
    DeclareOutcomeHandler,
    DraftDateHandler,
    GetDateSheetHandler,
    TransitionPublicationHandler,
    { provide: CLOCK, useValue: new SystemClock() },
    { provide: PUBLIC_WEB_ORIGIN, useValue: readPublicWebOrigin() },
  ],
})
export class DatesModule {}
