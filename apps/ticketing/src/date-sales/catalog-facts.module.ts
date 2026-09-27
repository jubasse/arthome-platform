import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { ApplyCatalogDateFactHandler } from './apply-catalog-date-fact.handler.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactionsModule } from '../ticketing-transactions.js';

/** What the consumer dispatches to, in its own process beside the API. */
@Module({
  imports: [TicketingTransactionsModule],
  providers: [ApplyCatalogDateFactHandler, { provide: CLOCK, useValue: new SystemClock() }],
})
export class CatalogFactsModule {}
