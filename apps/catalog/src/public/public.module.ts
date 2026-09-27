import { readPublicWebOrigin } from '@arthome-platform/config';
import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { GetArtistDetailHandler } from './get-artist-detail.handler.js';
import { GetDateDetailHandler } from './get-date-detail.handler.js';
import { PublicDatesController } from './public-dates.controller.js';
import { ResolvePublicLinkHandler } from './resolve-public-link.handler.js';
import { CLOCK } from '../clock.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

@Module({
  controllers: [PublicDatesController],
  providers: [
    GetDateDetailHandler,
    GetArtistDetailHandler,
    ResolvePublicLinkHandler,
    { provide: CLOCK, useValue: new SystemClock() },
    { provide: PUBLIC_WEB_ORIGIN, useValue: readPublicWebOrigin() },
  ],
})
export class PublicModule {}
