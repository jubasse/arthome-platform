import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { DatesController } from './dates.controller.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CLOCK } from '../clock.js';

@Module({
  imports: [CatalogModule],
  controllers: [DatesController],
  providers: [{ provide: CLOCK, useValue: new SystemClock() }],
})
export class DatesModule {}
