import { AllowInProduction } from '@arthome-platform/http-edge';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { FakePaymentProvider } from './fake-payment-provider.js';
import { PaymentWebhooksController } from './payment-webhooks.controller.js';
import { fakeOutsideProduction } from './payments.module.js';
import { OrdersController } from '../orders/orders.controller.js';

const SECRET = 'a-webhook-secret-long-enough-to-pass';

describe('the fake payment provider', () => {
  it('is bound outside production, so a clone runs with no key', () => {
    expect(fakeOutsideProduction({ NODE_ENV: 'test' })).toBeInstanceOf(FakePaymentProvider);
  });

  it('refuses to be bound in production, whatever secret is configured', () => {
    expect(() =>
      fakeOutsideProduction({ NODE_ENV: 'production', PAYMENT_WEBHOOK_SECRET: SECRET }),
    ).toThrow(/fake payment provider/);
  });

  it('leaves the routes that would reach it refused in production', () => {
    const reflector = new Reflector();
    for (const controller of [OrdersController, PaymentWebhooksController]) {
      expect(reflector.get(AllowInProduction, controller)).toBeUndefined();
    }
  });
});
