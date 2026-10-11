import { readStreamKeySecret } from '@arthome-platform/config';
import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { PrepareRunHandler } from './prepare-run.handler.js';
import { STREAM_KEY_SECRET } from './stream-key.js';
import { CLOCK } from '../clock.js';
import { StreamingTransactionsModule } from '../streaming-transactions.js';

/** What the consumer process dispatches to. */
@Module({
  imports: [StreamingTransactionsModule],
  providers: [
    { provide: CLOCK, useValue: new SystemClock() },
    { provide: STREAM_KEY_SECRET, useFactory: (): string => readStreamKeySecret() },
    PrepareRunHandler,
  ],
})
export class RunConsumerModule {}
