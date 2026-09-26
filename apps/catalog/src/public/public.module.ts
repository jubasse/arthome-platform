import { readPublicWebOrigin } from '@arthome-platform/config';
import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { PublicArtistsService } from './public-artists.service.js';
import { PublicDatesController } from './public-dates.controller.js';
import { PublicDatesService } from './public-dates.service.js';
import { PublicLinksService } from './public-links.service.js';
import { CLOCK } from '../clock.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

@Module({
  controllers: [PublicDatesController],
  providers: [
    PublicDatesService,
    PublicArtistsService,
    PublicLinksService,
    { provide: CLOCK, useValue: new SystemClock() },
    { provide: PUBLIC_WEB_ORIGIN, useValue: readPublicWebOrigin() },
  ],
})
export class PublicModule {}
