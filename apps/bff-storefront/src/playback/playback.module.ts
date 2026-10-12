import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { PLAYBACK_COOKIE_DOMAIN, PlaybackController } from './playback.controller.js';
import { STREAMING_URL, StreamingClient } from './streaming.client.js';
import { VIEWER_COUNTRY_HEADER } from '../auth/auth.controller.js';
import { CLOCK } from '../clock.js';
import { authEnv, playbackEnv } from '../env.js';
import { MinterModule } from '../minter.module.js';

@Module({
  imports: [MinterModule],
  controllers: [PlaybackController],
  providers: [
    StreamingClient,
    { provide: STREAMING_URL, useValue: playbackEnv.streamingUrl },
    { provide: PLAYBACK_COOKIE_DOMAIN, useValue: playbackEnv.cookieDomain },
    { provide: VIEWER_COUNTRY_HEADER, useValue: authEnv.viewerCountryHeader },
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class PlaybackModule {}
