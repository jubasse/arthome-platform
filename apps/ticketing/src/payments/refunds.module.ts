import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { OwedRefunds } from './owed-refunds.js';
import { PaymentsModule } from './payments.module.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactionsModule } from '../ticketing-transactions.js';

/** Listed once, here: the purchase and the payment worker refund through the same instance. */
@Module({
  imports: [TicketingTransactionsModule, PaymentsModule],
  providers: [OwedRefunds, { provide: CLOCK, useValue: new SystemClock() }],
  exports: [OwedRefunds],
})
export class RefundsModule {}
