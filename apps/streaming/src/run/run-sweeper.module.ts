import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { DATE_FACTS_PROVIDER } from './date-facts.js';
import {
  EndRunsByThemselvesHandler,
  RunAutoEndSweeper,
  RunPresenceSweeper,
  SweepRunPresenceHandler,
} from './run-passes.js';
import { CLOCK } from '../clock.js';
import { StreamingTransactionsModule } from '../streaming-transactions.js';

/** The run's two passes in the sweeper process, on Postgres alone. */
@Module({
  imports: [StreamingTransactionsModule],
  providers: [
    { provide: CLOCK, useValue: new SystemClock() },
    DATE_FACTS_PROVIDER,
    SweepRunPresenceHandler,
    EndRunsByThemselvesHandler,
    RunPresenceSweeper,
    RunAutoEndSweeper,
  ],
})
export class RunSweeperModule {}
