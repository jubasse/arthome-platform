import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { CatalogController } from './catalog.controller.js';
import { PublishShowHandler } from './publish-show.handler.js';
import { UpdateShowHandler } from './update-show.handler.js';
import { CatalogTransactionsModule } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';

@Module({
  imports: [CatalogTransactionsModule],
  controllers: [CatalogController],
  providers: [
    PublishShowHandler,
    UpdateShowHandler,
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class CatalogModule {}
