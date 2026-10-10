import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { PlaybackDesk } from './playback-desk.js';
import { PlaybackController } from './playback.controller.js';
import { NoPreviewMeter, PREVIEW_METER } from './preview-meter.js';
import { CLOCK } from '../clock.js';
import { MediaModule } from '../media/media.module.js';
import { StreamingTransactionsModule } from '../streaming-transactions.js';

/** The player's routes in the API process. PS4 replaces the `PreviewMeter` binding. */
@Module({
  imports: [StreamingTransactionsModule, MediaModule],
  controllers: [PlaybackController],
  providers: [
    { provide: CLOCK, useValue: new SystemClock() },
    { provide: PREVIEW_METER, useClass: NoPreviewMeter },
    PlaybackDesk,
  ],
})
export class PlaybackModule {}
