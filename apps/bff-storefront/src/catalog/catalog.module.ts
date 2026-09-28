import { Module } from '@nestjs/common';

import { CATALOG_BUDGETS, TRANSPORT_BUDGETS } from './catalog-budgets.js';
import { CATALOG_URL, CatalogClient } from './catalog.client.js';
import { env } from '../env.js';

@Module({
  providers: [
    CatalogClient,
    { provide: CATALOG_URL, useValue: env.CATALOG_URL },
    { provide: CATALOG_BUDGETS, useValue: TRANSPORT_BUDGETS },
  ],
  exports: [CatalogClient, CATALOG_BUDGETS],
})
export class CatalogModule {}
