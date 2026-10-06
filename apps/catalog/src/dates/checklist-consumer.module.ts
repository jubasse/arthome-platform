import { readPublicWebOrigin } from '@arthome-platform/config';
import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { LearnRunFactHandler } from './learn-run-fact.handler.js';
import { RecordChecklistFactHandler } from './record-checklist-fact.handler.js';
import { CatalogTransactionsModule } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/** What the consumer dispatches to, in its own process beside the API. */
@Module({
  imports: [CatalogTransactionsModule],
  providers: [
    RecordChecklistFactHandler,
    LearnRunFactHandler,
    { provide: CLOCK, useValue: new SystemClock() },
    { provide: PUBLIC_WEB_ORIGIN, useValue: readPublicWebOrigin() },
  ],
})
export class ChecklistConsumerModule {}
