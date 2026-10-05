import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { PaymentWebhooksController } from './payment-webhooks.controller.js';
import { PaymentsModule } from './payments.module.js';
import { RecordPaymentEventHandler } from './record-payment-event.handler.js';
import { CLOCK } from '../clock.js';

/** The provider's webhooks, recorded in the API process. */
@Module({
  imports: [PaymentsModule],
  controllers: [PaymentWebhooksController],
  providers: [RecordPaymentEventHandler, { provide: CLOCK, useValue: new SystemClock() }],
})
export class PaymentWebhooksModule {}
