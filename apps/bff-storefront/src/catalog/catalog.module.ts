import { Module } from '@nestjs/common';

import { CATALOG_URL, CatalogClient } from './catalog.client.js';
import { env } from '../env.js';
import { MinterModule } from '../minter.module.js';

@Module({
  imports: [MinterModule],
  providers: [CatalogClient, { provide: CATALOG_URL, useValue: env.CATALOG_URL }],
  exports: [CatalogClient],
})
export class CatalogModule {}
