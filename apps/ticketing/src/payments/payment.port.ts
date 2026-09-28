import type { Instant, Money } from '@arthome/core';

/**
 * adr-payments.md §4's ports, held here until core carries them (HANDOVER §3). The domain never
 *   reads a provider's identifier: an intent's and a refund's references are opaque strings.
 */

export const INTENT_STATUSES = ['succeeded', 'requires_action', 'processing', 'declined'] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

export const IntentStatus = {
  SUCCEEDED: 'succeeded',
  REQUIRES_ACTION: 'requires_action',
  PROCESSING: 'processing',
  DECLINED: 'declined',
} as const;

/** The storefront's `PaymentHandoff.nextAction.kind`, as the provider declares it. */
export const NEXT_ACTION_KINDS = ['redirect_to_url', 'use_stripe_sdk'] as const;
export type NextActionKind = (typeof NEXT_ACTION_KINDS)[number];

export const NextActionKind = {
  REDIRECT_TO_URL: 'redirect_to_url',
  USE_STRIPE_SDK: 'use_stripe_sdk',
} as const;

export interface NextAction {
  readonly kind: NextActionKind;
  readonly redirectUrl: string | null;
}

export interface PaymentIntentRequest {
  /** The provider's idempotency key: a retry after a crash finds the intent already created. */
  readonly orderId: string;
  readonly amount: Money;
  /** The hold's instant (adr-payments.md §8 rule 2): the intent and the hold expire together. */
  readonly expiresAt: Instant;
  readonly returnUrl: string;
}

export interface PaymentIntent {
  readonly ref: string;
  readonly status: IntentStatus;
  /** Serves the surface's payment element alone, and authorises nothing else. */
  readonly clientSecret: string;
  readonly nextAction: NextAction | null;
  /** The provider's reason, when `declined`. */
  readonly declineCode: string | null;
}

export interface RefundRequest {
  readonly intentRef: string;
  readonly amount: Money;
  /** `refund:{orderId}` (adr-ticketing.md §8): a refund asked twice is made once. */
  readonly idempotencyKey: string;
}

/**
 * The provider could not be reached or did not answer: nothing is known of what it did, so the
 *   caller retries under the same idempotency key, never a new one.
 */
export class PaymentProviderUnavailable extends Error {
  public override readonly name = 'PaymentProviderUnavailable';
}

export abstract class PaymentPort {
  /** Throws `PaymentProviderUnavailable` when the provider cannot say what it did. */
  public abstract createIntent(request: PaymentIntentRequest): Promise<PaymentIntent>;

  /** Best effort (adr-ticketing.md §6): an intent that already succeeded stays succeeded. */
  public abstract cancelIntent(intentRef: string, idempotencyKey: string): Promise<void>;

  public abstract refund(request: RefundRequest): Promise<{ readonly refundRef: string }>;
}

/** What a provider's webhook says happened to an intent, recorded before anything reads it. */
export const PAYMENT_EVENT_KINDS = [
  'intent_succeeded',
  'intent_requires_action',
  'intent_processing',
  'intent_failed',
  'intent_canceled',
  'unhandled',
] as const;
export type PaymentEventKind = (typeof PAYMENT_EVENT_KINDS)[number];

export const PaymentEventKind = {
  INTENT_SUCCEEDED: 'intent_succeeded',
  INTENT_REQUIRES_ACTION: 'intent_requires_action',
  INTENT_PROCESSING: 'intent_processing',
  INTENT_FAILED: 'intent_failed',
  INTENT_CANCELED: 'intent_canceled',
  UNHANDLED: 'unhandled',
} as const;

export interface PaymentEvent {
  /** Unique per event at the provider, which replays for days: the inbox's key. */
  readonly eventId: string;
  readonly kind: PaymentEventKind;
  readonly intentRef: string | null;
  /** The order the intent was created for, as its metadata carries it. */
  readonly orderId: string | null;
  readonly occurredAt: Instant;
  readonly declineCode: string | null;
}

/**
 * Signed webhooks, verified on the exact bytes received (adr-payments.md §7.1) before anything
 *   parses them.
 */
export abstract class PaymentWebhookPort {
  /** The request header the provider puts its signature in. */
  public abstract readonly signatureHeader: string;

  /** False for bytes the signature does not cover, or a signature outside the clock tolerance. */
  public abstract verifySignature(
    rawBody: Buffer,
    signature: string | undefined,
    now: Instant,
  ): boolean;

  /** Null for bytes that are no event of this provider's. */
  public abstract parse(rawBody: Buffer): PaymentEvent | null;
}
