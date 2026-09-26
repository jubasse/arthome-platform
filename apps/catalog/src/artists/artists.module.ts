import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { ArtistsController } from './artists.controller.js';
import { ArtistsService } from './artists.service.js';
import { CLOCK } from '../clock.js';

@Module({
  controllers: [ArtistsController],
  providers: [ArtistsService, { provide: CLOCK, useValue: new SystemClock() }],
})
export class ArtistsModule {}
