import type { PaymentIntent } from '@arthome/core';

/** The kinds the fake provider and the suites speak; core keeps a next action's `kind` opaque. */
export const NextActionKind = {
  REDIRECT_TO_URL: 'redirect_to_url',
  USE_STRIPE_SDK: 'use_stripe_sdk',
} as const;

export type NextAction = NonNullable<PaymentIntent['nextAction']>;
