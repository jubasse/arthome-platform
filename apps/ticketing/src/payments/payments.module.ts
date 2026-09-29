import { readPaymentWebhookSecret } from '@arthome-platform/config';
import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { FakePaymentProvider } from './fake-payment-provider.js';
import { PaymentPort, PaymentWebhookPort } from './payment.port.js';

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
    { provide: PaymentPort, useExisting: FakePaymentProvider },
    { provide: PaymentWebhookPort, useExisting: FakePaymentProvider },
  ],
  exports: [PaymentPort, PaymentWebhookPort, FakePaymentProvider],
})
export class PaymentsModule {}
