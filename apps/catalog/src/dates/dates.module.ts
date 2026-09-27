import { readPublicWebOrigin } from '@arthome-platform/config';
import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { DatesController } from './dates.controller.js';
import { DeclareOutcomeHandler } from './declare-outcome.handler.js';
import { DraftDateHandler } from './draft-date.handler.js';
import { GetDateSheetHandler } from './get-date-sheet.handler.js';
import { TransitionPublicationHandler } from './transition-publication.handler.js';
import { CatalogTransactionsModule } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

@Module({
  imports: [CatalogTransactionsModule],
  controllers: [DatesController],
  providers: [
    DeclareOutcomeHandler,
    DraftDateHandler,
    GetDateSheetHandler,
    TransitionPublicationHandler,
    { provide: CLOCK, useValue: new SystemClock() },
    { provide: PUBLIC_WEB_ORIGIN, useValue: readPublicWebOrigin() },
  ],
})
export class DatesModule {}
