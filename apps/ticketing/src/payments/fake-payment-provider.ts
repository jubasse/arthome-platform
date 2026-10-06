import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import {
  PAYMENT_WEBHOOK_TOLERANCE_SECONDS,
  fromEpochMs,
  money,
  toEpochMs,
  type Clock,
  type Instant,
  IntentStatus,
  PaymentEventKind,
  PaymentProviderUnavailable,
  type PaymentEvent,
  type PaymentIntent,
  type PaymentIntentRequest,
  type PaymentPort,
  type PaymentWebhookPort,
  type Money,
  type RefundRequest,
} from '@arthome/core';

import { NextActionKind } from './next-action.js';

/** What the fake does with an intent it creates, chosen per request (adr-payments.md §4). */
export const FAKE_PAYMENT_SCENARIOS = [
  'confirm',
  'require_action',
  'decline',
  'unavailable',
] as const;
export type FakePaymentScenario = (typeof FAKE_PAYMENT_SCENARIOS)[number];

export const FakePaymentScenario = {
  /** Confirmed synchronously, as a saved card without strong authentication is. */
  CONFIRM: 'confirm',
  /** Strong authentication first; `completeAction` or `failAction` then says how it ended. */
  REQUIRE_ACTION: 'require_action',
  DECLINE: 'decline',
  /** The provider does not answer, and creates nothing. */
  UNAVAILABLE: 'unavailable',
} as const;

const SIGNATURE = /^t=(\d+),v1=([0-9a-f]{64})$/;

const EVENT_KIND_OF_TYPE: Readonly<Record<string, PaymentEventKind>> = {
  'payment_intent.succeeded': PaymentEventKind.INTENT_SUCCEEDED,
  'payment_intent.requires_action': PaymentEventKind.INTENT_REQUIRES_ACTION,
  'payment_intent.processing': PaymentEventKind.INTENT_PROCESSING,
  'payment_intent.payment_failed': PaymentEventKind.INTENT_FAILED,
  'payment_intent.canceled': PaymentEventKind.INTENT_CANCELLED,
};

/** Stripe's names for the two facts about a charge already taken. */
const REFUNDED_TYPE = 'charge.refunded';
const DISPUTED_TYPE = 'charge.dispute.created';

const TYPE_OF_EVENT_KIND: Readonly<Partial<Record<PaymentEventKind, string>>> = {
  ...Object.fromEntries(Object.entries(EVENT_KIND_OF_TYPE).map(([type, kind]) => [kind, type])),
  [PaymentEventKind.REFUND_SUCCEEDED]: REFUNDED_TYPE,
  [PaymentEventKind.DISPUTE_OPENED]: DISPUTED_TYPE,
};

const KIND_OF_TYPE: Readonly<Record<string, PaymentEventKind>> = {
  ...EVENT_KIND_OF_TYPE,
  [REFUNDED_TYPE]: PaymentEventKind.REFUND_SUCCEEDED,
  [DISPUTED_TYPE]: PaymentEventKind.DISPUTE_OPENED,
};

const FakeEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  created: z.int().positive(),
  data: z.object({
    object: z.object({
      id: z.string().min(1),
      metadata: z.object({ order_id: z.string().nullable() }),
      last_payment_error: z.object({ decline_code: z.string() }).nullable(),
      latest_refund: z.string().min(1).optional(),
      amount_refunded: z.int().min(0).optional(),
      currency: z.string().length(3).optional(),
    }),
  }),
});

export interface SignedWebhook {
  readonly body: Buffer;
  readonly signature: string;
}

interface FakeIntent {
  readonly orderId: string;
  readonly intent: PaymentIntent;
  canceled: boolean;
}

interface FakeRefund {
  readonly ref: string;
  readonly intentRef: string;
  readonly amount: Money;
}

/**
 * adr-payments.md §4's default adapter: deterministic, no network, no key. References are derived
 *   from the order id and event ids counted, so a suite can name what it expects; the scenario of
 *   each intent is `scenarioOf`'s, `confirm` unless a suite says otherwise. Both ports at once,
 *   since a webhook speaks of the intents this instance created.
 */
export class FakePaymentProvider implements PaymentPort, PaymentWebhookPort {
  public readonly signatureHeader = 'x-fake-payment-signature';

  public scenarioOf: (request: PaymentIntentRequest) => FakePaymentScenario = () =>
    FakePaymentScenario.CONFIRM;

  /** Every call throws `PaymentProviderUnavailable` while true: the provider-down drill. */
  public down = false;

  /** Every call that reached the provider, in order, retries included. */
  public readonly calls: string[] = [];

  private readonly intentsByOrder = new Map<string, FakeIntent>();
  /** In the order they were made, one per idempotency key. */
  private readonly refundsByKey = new Map<string, FakeRefund>();
  private readonly disputedIntentRefs = new Set<string>();
  private events = 0;

  public constructor(
    private readonly webhookSecret: string,
    private readonly clock: Clock,
  ) {}

  public createIntent(request: PaymentIntentRequest): Promise<PaymentIntent> {
    return this.answer(`createIntent ${request.orderId}`, () => {
      const existing = this.intentsByOrder.get(request.orderId);
      if (existing !== undefined) return existing.intent;

      const scenario = this.scenarioOf(request);
      if (scenario === FakePaymentScenario.UNAVAILABLE) {
        throw new PaymentProviderUnavailable(`fake provider did not answer for ${request.orderId}`);
      }
      const ref = intentRefOf(request.orderId);
      const intent: PaymentIntent = {
        ref,
        status: STATUS_OF_SCENARIO[scenario],
        clientSecret: `${ref}_secret`,
        nextAction:
          scenario === FakePaymentScenario.REQUIRE_ACTION
            ? {
                kind: NextActionKind.REDIRECT_TO_URL,
                redirectUrl: `https://payments.fake.invalid/authenticate/${ref}`,
              }
            : null,
        declineCode: scenario === FakePaymentScenario.DECLINE ? 'card_declined' : null,
      };
      this.intentsByOrder.set(request.orderId, {
        orderId: request.orderId,
        intent,
        canceled: false,
      });
      return intent;
    });
  }

  public cancelIntent(intentRef: string, idempotencyKey: string): Promise<void> {
    return this.answer(`cancelIntent ${idempotencyKey}`, () => {
      const found = this.intentAskedOf(intentRef);
      if (found.intent.status !== IntentStatus.SUCCEEDED) found.canceled = true;
    });
  }

  /** A charge under dispute is refused, as Stripe refuses it: a refusal, never an outage. */
  public refund({
    intentRef,
    amount,
    idempotencyKey,
  }: RefundRequest): Promise<{ refundRef: string }> {
    return this.answer(`refund ${idempotencyKey}`, () => {
      const made = this.refundsByKey.get(idempotencyKey);
      if (made !== undefined) return { refundRef: made.ref };
      if (this.intentAskedOf(intentRef).intent.status !== IntentStatus.SUCCEEDED) {
        throw new Error(`fake provider: intent ${intentRef} has taken no money to refund`);
      }
      if (this.disputedIntentRefs.has(intentRef)) {
        throw new Error(`fake provider: the charge of intent ${intentRef} is disputed`);
      }
      const refundRef = `re_fake_${digest(idempotencyKey)}`;
      this.refundsByKey.set(idempotencyKey, { ref: refundRef, intentRef, amount });
      return { refundRef };
    });
  }

  /** The refunds actually made, one per idempotency key however often it was asked. */
  public get refundsMade(): number {
    return this.refundsByKey.size;
  }

  public isCanceled(intentRef: string): boolean {
    return this.intentByRef(intentRef).canceled;
  }

  /** The strong authentication succeeded: the intent is confirmed, and its webhook returned. */
  public completeAction(intentRef: string): SignedWebhook {
    this.settle(intentRef, IntentStatus.SUCCEEDED);
    return this.webhookOf(intentRef, PaymentEventKind.INTENT_SUCCEEDED);
  }

  public failAction(intentRef: string): SignedWebhook {
    this.settle(intentRef, IntentStatus.DECLINED);
    return this.webhookOf(intentRef, PaymentEventKind.INTENT_FAILED);
  }

  /**
   * The webhook of a refund made, carrying what was refunded on its charge up to it: what the
   *   provider sends whether or not its answer reached the caller.
   */
  public refundSucceededWebhookOf(refundRef: string): SignedWebhook {
    const made = [...this.refundsByKey.values()];
    const index = made.findIndex(({ ref }) => ref === refundRef);
    const refund = made[index];
    if (refund === undefined) throw new Error(`fake provider: no refund ${refundRef}`);
    const refunded = made
      .slice(0, index + 1)
      .filter(({ intentRef }) => intentRef === refund.intentRef)
      .reduce((total, { amount }) => total + amount.amountMinor, 0);
    return this.webhookOf(refund.intentRef, PaymentEventKind.REFUND_SUCCEEDED, {
      latest_refund: refundRef,
      amount_refunded: refunded,
      currency: refund.amount.currencyCode.toLowerCase(),
    });
  }

  /**
   * The buyer's bank disputes the charge: the intent is confirmed, since only a charge taken can be
   *   disputed, its refunds refused from now on, and the dispute's webhook returned.
   */
  public disputeOpened(intentRef: string): SignedWebhook {
    this.settle(intentRef, IntentStatus.SUCCEEDED);
    this.disputedIntentRefs.add(intentRef);
    return this.webhookOf(intentRef, PaymentEventKind.DISPUTE_OPENED);
  }

  /** A new event about the intent, as the provider would send it, signed now. */
  public webhookOf(
    intentRef: string,
    kind: PaymentEventKind,
    chargeFacts: Readonly<Record<string, unknown>> = {},
  ): SignedWebhook {
    const { orderId, intent } = this.intentByRef(intentRef);
    this.events += 1;
    const body = Buffer.from(
      JSON.stringify({
        id: `evt_fake_${String(this.events).padStart(6, '0')}`,
        type: TYPE_OF_EVENT_KIND[kind] ?? 'charge.succeeded',
        created: Math.floor(this.clock.nowMs() / 1_000),
        data: {
          object: {
            id: intent.ref,
            metadata: { order_id: orderId },
            last_payment_error:
              intent.declineCode === null ? null : { decline_code: intent.declineCode },
            ...chargeFacts,
          },
        },
      }),
    );
    return { body, signature: this.sign(body, this.clock.now()) };
  }

  public sign(body: Buffer, at: Instant): string {
    const seconds = String(Math.floor(toEpochMs(at) / 1_000));
    return `t=${seconds},v1=${this.mac(seconds, body).toString('hex')}`;
  }

  public verifySignature(
    rawBody: Uint8Array,
    signature: string | undefined,
    now: Instant,
  ): boolean {
    const match = SIGNATURE.exec(signature ?? '');
    const [, seconds, received] = match ?? [];
    if (seconds === undefined || received === undefined) return false;
    const skewSeconds = Math.abs(toEpochMs(now) / 1_000 - Number(seconds));
    if (skewSeconds > PAYMENT_WEBHOOK_TOLERANCE_SECONDS) return false;
    const expected = this.mac(seconds, rawBody);
    const given = Buffer.from(received, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  public parse(rawBody: Uint8Array): PaymentEvent | null {
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(rawBody).toString('utf8'));
    } catch {
      return null;
    }
    const parsed = FakeEventSchema.safeParse(json);
    if (!parsed.success) return null;
    const { id, type, created, data } = parsed.data;
    const kind = KIND_OF_TYPE[type] ?? PaymentEventKind.UNHANDLED;
    const { latest_refund: refundRef, amount_refunded: refunded, currency } = data.object;
    const refundFacts = kind === PaymentEventKind.REFUND_SUCCEEDED;
    return {
      eventId: id,
      kind,
      intentRef: data.object.id,
      orderId: data.object.metadata.order_id,
      occurredAt: fromEpochMs(created * 1_000),
      declineCode: data.object.last_payment_error?.decline_code ?? null,
      refundRef: refundFacts ? (refundRef ?? null) : null,
      amountRefunded:
        refundFacts && refunded !== undefined && currency !== undefined
          ? money(refunded, currency.toUpperCase())
          : null,
    };
  }

  /** Records the call and runs it as the provider would answer: a failure is a rejection. */
  private answer<T>(call: string, work: () => T): Promise<T> {
    this.calls.push(call);
    try {
      if (this.down) throw new PaymentProviderUnavailable(`fake provider is down: ${call}`);
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private settle(intentRef: string, status: IntentStatus): void {
    const found = this.intentByRef(intentRef);
    found.canceled = false;
    this.intentsByOrder.set(found.orderId, {
      ...found,
      intent: {
        ...found.intent,
        status,
        nextAction: null,
        declineCode: status === IntentStatus.DECLINED ? 'card_declined' : null,
      },
    });
  }

  private intentByRef(intentRef: string): FakeIntent {
    for (const found of this.intentsByOrder.values()) {
      if (found.intent.ref === intentRef) return found;
    }
    throw new Error(`fake provider: no intent ${intentRef}`);
  }

  /**
   * For the two calls a worker makes, `refund` and `cancelIntent`: an intent another instance
   *   created, the API's, is known by its reference, its order's, as confirmed, which is what the
   *   running fake makes of every intent. The test helpers stay strict.
   */
  private intentAskedOf(intentRef: string): FakeIntent {
    const known = [...this.intentsByOrder.values()].find(({ intent }) => intent.ref === intentRef);
    if (known !== undefined) return known;
    const orderId = orderIdOfIntentRef(intentRef);
    if (orderId === null) throw new Error(`fake provider: no intent ${intentRef}`);
    const confirmed: FakeIntent = {
      orderId,
      intent: {
        ref: intentRef,
        status: IntentStatus.SUCCEEDED,
        clientSecret: `${intentRef}_secret`,
        nextAction: null,
        declineCode: null,
      },
      canceled: false,
    };
    this.intentsByOrder.set(orderId, confirmed);
    return confirmed;
  }

  private mac(seconds: string, body: Uint8Array): Buffer {
    return createHmac('sha256', this.webhookSecret).update(`${seconds}.`).update(body).digest();
  }
}

const STATUS_OF_SCENARIO: Readonly<
  Record<Exclude<FakePaymentScenario, typeof FakePaymentScenario.UNAVAILABLE>, IntentStatus>
> = {
  [FakePaymentScenario.CONFIRM]: IntentStatus.SUCCEEDED,
  [FakePaymentScenario.REQUIRE_ACTION]: IntentStatus.REQUIRES_ACTION,
  [FakePaymentScenario.DECLINE]: IntentStatus.DECLINED,
};

export function intentRefOf(orderId: string): string {
  return `pi_fake_${orderId.replaceAll('-', '')}`;
}

const INTENT_REF = /^pi_fake_([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/;

function orderIdOfIntentRef(intentRef: string): string | null {
  const parts = INTENT_REF.exec(intentRef);
  return parts === null ? null : parts.slice(1).join('-');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}
