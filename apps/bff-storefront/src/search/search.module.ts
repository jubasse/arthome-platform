import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { SearchController } from './search.controller.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CLOCK } from '../clock.js';

@Module({
  imports: [CatalogModule],
  controllers: [SearchController],
  providers: [{ provide: CLOCK, useValue: new SystemClock() }],
})
export class SearchModule {}
