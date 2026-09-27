import { Module } from '@nestjs/common';

import { RecordChecklistFactHandler } from './record-checklist-fact.handler.js';
import { CatalogTransactionsModule } from '../catalog-transactions.js';

/** What the checklist consumer dispatches to, in its own process beside the API. */
@Module({ imports: [CatalogTransactionsModule], providers: [RecordChecklistFactHandler] })
export class ChecklistConsumerModule {}
