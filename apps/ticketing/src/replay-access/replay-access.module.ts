import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { RecordReplayStateHandler } from './record-replay-state.handler.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactionsModule } from '../ticketing-transactions.js';

@Module({
  imports: [TicketingTransactionsModule],
  providers: [RecordReplayStateHandler, { provide: CLOCK, useValue: new SystemClock() }],
})
export class ReplayAccessModule {}
