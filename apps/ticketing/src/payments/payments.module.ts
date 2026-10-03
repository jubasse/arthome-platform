import { readPaymentWebhookSecret } from '@arthome-platform/config';
import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { FakePaymentProvider } from './fake-payment-provider.js';
import { PAYMENT_PORT, PAYMENT_WEBHOOK_PORT } from './payment-tokens.js';

/**
 * The payment ports, bound to the fake adapter: adr-payments.md §4 makes it the default, so a clone
 *   runs with no key and no network. A Stripe adapter replaces the one provider here.
 */
@Module({
  providers: [
    {
      provide: FakePaymentProvider,
      useFactory: (): FakePaymentProvider =>
        new FakePaymentProvider(readPaymentWebhookSecret(), new SystemClock()),
    },
    { provide: PAYMENT_PORT, useExisting: FakePaymentProvider },
    { provide: PAYMENT_WEBHOOK_PORT, useExisting: FakePaymentProvider },
  ],
  exports: [PAYMENT_PORT, PAYMENT_WEBHOOK_PORT, FakePaymentProvider],
})
export class PaymentsModule {}
