import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { ExpireLapsedLeasesHandler, PlaybackLeaseSweeper } from './lease-sweep.js';
import { CLOCK } from '../clock.js';

/** The lease-expiry pass in the sweeper process. */
@Module({
  providers: [
    { provide: CLOCK, useValue: new SystemClock() },
    ExpireLapsedLeasesHandler,
    PlaybackLeaseSweeper,
  ],
})
export class PlaybackSweeperModule {}
