import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { AvailabilityController } from './availability.controller.js';
import { GetDateAvailabilityHandler } from './get-date-availability.handler.js';
import { CLOCK } from '../clock.js';

/** The storefront's read of a date's seats and prices, in the API process. */
@Module({
  controllers: [AvailabilityController],
  providers: [GetDateAvailabilityHandler, { provide: CLOCK, useValue: new SystemClock() }],
})
export class AvailabilityModule {}
