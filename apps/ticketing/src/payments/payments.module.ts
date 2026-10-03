import { isProductionEnvironment, readPaymentWebhookSecret } from '@arthome-platform/config';
import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { FakePaymentProvider } from './fake-payment-provider.js';
import { PAYMENT_PORT, PAYMENT_WEBHOOK_PORT } from './payment-tokens.js';

/**
 * The fake confirms every intent without taking any money: bound in production, it would sell seats
 *   for nothing. So a production boot of anything that imports the payment ports fails here.
 */
export function fakeOutsideProduction(
  source: Record<string, string | undefined> = process.env,
): FakePaymentProvider {
  if (isProductionEnvironment(source)) {
    throw new Error('PaymentsModule: the fake payment provider cannot be bound in production');
  }
  return new FakePaymentProvider(readPaymentWebhookSecret(source), new SystemClock());
}

/**
 * The payment ports, bound to the fake adapter: adr-payments.md §4 makes it the default, so a clone
 *   runs with no key and no network. A Stripe adapter replaces the one provider here.
 */
@Module({
  providers: [
    {
      provide: FakePaymentProvider,
      useFactory: (): FakePaymentProvider => fakeOutsideProduction(),
    },
    { provide: PAYMENT_PORT, useExisting: FakePaymentProvider },
    { provide: PAYMENT_WEBHOOK_PORT, useExisting: FakePaymentProvider },
  ],
  exports: [PAYMENT_PORT, PAYMENT_WEBHOOK_PORT, FakePaymentProvider],
})
export class PaymentsModule {}
