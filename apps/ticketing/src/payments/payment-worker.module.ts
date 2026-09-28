import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { ApplyPaymentEventsHandler } from './apply-payment-events.handler.js';
import { CancelOwedIntentsHandler } from './cancel-owed-intents.handler.js';
import { PaymentWorker } from './payment-worker.js';
import { PaymentsModule } from './payments.module.js';
import { RefundOwedPaymentsHandler } from './refund-owed-payments.handler.js';
import { RefundsModule } from './refunds.module.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactionsModule } from '../ticketing-transactions.js';

/** The API process's payment worker and the three commands it runs. */
@Module({
  imports: [TicketingTransactionsModule, PaymentsModule, RefundsModule],
  providers: [
    ApplyPaymentEventsHandler,
    RefundOwedPaymentsHandler,
    CancelOwedIntentsHandler,
    PaymentWorker,
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class PaymentWorkerModule {}
