import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { RevokeDeviceLeasesHandler } from './revoke-device-leases.handler.js';
import { RevokeProfileLeasesHandler } from './revoke-profile-leases.handler.js';
import { CLOCK } from '../clock.js';
import { StreamingTransactionsModule } from '../streaming-transactions.js';

/** Identity's device events in the consumer process: the leases they revoke. */
@Module({
  imports: [StreamingTransactionsModule],
  providers: [
    RevokeDeviceLeasesHandler,
    RevokeProfileLeasesHandler,
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class DevicesConsumerModule {}
