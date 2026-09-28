import { Module } from '@nestjs/common';

import { CATALOG_URL, CatalogClient } from './catalog.client.js';
import { env } from '../env.js';

@Module({
  providers: [CatalogClient, { provide: CATALOG_URL, useValue: env.CATALOG_URL }],
  exports: [CatalogClient],
})
export class CatalogModule {}
