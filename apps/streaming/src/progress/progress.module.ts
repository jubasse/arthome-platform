import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { ProgressController } from './progress.controller.js';
import { CLOCK } from '../clock.js';

/** The resume points' routes in the API process. */
@Module({
  controllers: [ProgressController],
  providers: [{ provide: CLOCK, useValue: new SystemClock() }],
})
export class ProgressModule {}
