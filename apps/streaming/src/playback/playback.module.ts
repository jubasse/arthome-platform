import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { PlaybackDesk } from './playback-desk.js';
import { PlaybackController } from './playback.controller.js';
import { CLOCK } from '../clock.js';
import { MediaModule } from '../media/media.module.js';
import { PreviewModule } from '../preview/preview.module.js';
import { StreamingTransactionsModule } from '../streaming-transactions.js';

/** The player's routes in the API process; the preview budget is `PreviewModule`'s. */
@Module({
  imports: [StreamingTransactionsModule, MediaModule, PreviewModule],
  controllers: [PlaybackController],
  providers: [{ provide: CLOCK, useValue: new SystemClock() }, PlaybackDesk],
})
export class PlaybackModule {}
