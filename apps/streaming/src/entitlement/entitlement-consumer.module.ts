import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { RecordDateFactHandler } from './record-date-fact.handler.js';
import { RecordSeatFactHandler } from './record-seat-fact.handler.js';
import { RecordSubscriptionFactHandler } from './record-subscription-fact.handler.js';
import { CLOCK } from '../clock.js';
import { StreamingTransactionsModule } from '../streaming-transactions.js';

/** What the consumer process dispatches to. */
@Module({
  imports: [StreamingTransactionsModule],
  providers: [
    RecordSeatFactHandler,
    RecordSubscriptionFactHandler,
    RecordDateFactHandler,
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class EntitlementConsumerModule {}
