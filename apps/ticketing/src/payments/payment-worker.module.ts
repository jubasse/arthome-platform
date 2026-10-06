import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { ApplyPaymentEventsHandler } from './apply-payment-events.handler.js';
import { PaymentWorker } from './payment-worker.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactionsModule } from '../ticketing-transactions.js';

/** The API process's payment worker and the command it runs. */
@Module({
  imports: [TicketingTransactionsModule],
  providers: [
    ApplyPaymentEventsHandler,
    PaymentWorker,
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class PaymentWorkerModule {}
