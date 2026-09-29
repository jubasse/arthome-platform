import { frozen } from '@arthome-platform/transactions';
import { AggregateRoot } from '@nestjs/cqrs';

import type {
  Instant,
  Money,
  OrderErrorCode,
  PriceTier,
  RefundReason,
  OrderQuote as CoreOrderQuote,
} from '@arthome/core';

import {
  ORDER_STATES_AWAITING_PAYMENT,
  OrderState,
  SeatState,
  movesForward,
} from './commerce-vocabulary.js';
import {
  SeatOrderFailed,
  SeatOrderHoldRenewed,
  SeatOrderIntentRecorded,
  SeatOrderPaid,
  SeatOrderPlaced,
  SeatOrderRefundOwed,
  SeatOrderRefunded,
  type SeatOrderEvent,
} from './seat-order.events.js';
import type { NextAction } from '../payments/payment.port.js';

/** Core's four lines, and the unit price they were composed from, frozen at placement. */
export interface OrderQuote extends CoreOrderQuote {
  readonly unitPrice: Money;
}

/** The buyer's own statement of where they are: one piece of tax evidence among others (D-021). */
export interface DeclaredTaxLocation {
  readonly country: string;
  readonly subdivision: string | null;
  readonly postalCode: string | null;
}

export interface PaymentIntentRecord {
  readonly ref: string;
  /** Null for an intent learnt of by its webhook alone, which carries no secret. */
  readonly clientSecret: string | null;
  readonly nextAction: NextAction | null;
}

export interface SeatSnapshot {
  readonly id: string;
  /** Issued by the server, core's `seatCode` (data-model.md §3.3). */
  readonly code: string;
  readonly tier: PriceTier;
  readonly state: SeatState;
  readonly cancelDeadline: Instant | null;
  readonly activatedAt: Instant;
}

/** A seat about to be created: its id and code drawn by the service, its deadline served. */
export interface SeatIssue {
  readonly id: string;
  readonly code: string;
  readonly cancelDeadline: Instant | null;
}

export interface OrderFailure {
  /** The refusal a replay of the purchase answers again; null for a hold that expired unpaid. */
  readonly code: OrderErrorCode | null;
  readonly declineCode: string | null;
}

export interface OrderRefund {
  readonly reason: RefundReason;
  readonly owedAt: Instant;
  readonly ref: string | null;
  readonly refundedAt: Instant | null;
}

export interface SeatOrderSnapshot {
  readonly id: string;
  /** Readable, the one support reads out over the phone. */
  readonly reference: string;
  readonly dateId: string;
  readonly channelId: string;
  readonly accountId: string | null;
  readonly profileId: string | null;
  readonly tier: PriceTier;
  readonly quantity: number;
  readonly quote: OrderQuote;
  readonly declaredTaxLocation: DeclaredTaxLocation | null;
  readonly holdId: string;
  /** The hold's, and the handoff's (adr-ticketing.md §2): one instant. */
  readonly expiresAt: Instant;
  readonly state: OrderState;
  readonly intent: PaymentIntentRecord | null;
  readonly failure: OrderFailure | null;
  readonly refund: OrderRefund | null;
  /** When the order failed holding an intent the provider may still confirm (adr-ticketing.md §6). */
  readonly intentCancelOwedAt: Instant | null;
  readonly placedAt: Instant;
  readonly paidAt: Instant | null;
  readonly seats: readonly SeatSnapshot[];
  readonly version: number;
}

export interface SeatOrderPlacement {
  readonly id: string;
  readonly reference: string;
  readonly dateId: string;
  readonly channelId: string;
  readonly accountId: string | null;
  readonly profileId: string | null;
  readonly tier: PriceTier;
  readonly quantity: number;
  readonly quote: OrderQuote;
  readonly declaredTaxLocation: DeclaredTaxLocation | null;
  readonly holdId: string;
  readonly expiresAt: Instant;
}

/**
 * The intent as known, completed by what the provider tells of the same one: a webhook carries no
 *   client secret and no next action, the purchase's own answer does, in whichever order they land.
 */
function completedIntent(
  known: PaymentIntentRecord | null,
  told: PaymentIntentRecord,
): PaymentIntentRecord {
  if (known === null) return told;
  if (known.ref !== told.ref) return known;
  const clientSecret = known.clientSecret ?? told.clientSecret;
  const nextAction = known.nextAction ?? told.nextAction;
  if (clientSecret === known.clientSecret && nextAction === known.nextAction) return known;
  return { ref: known.ref, clientSecret, nextAction };
}

/**
 * data-model.md §3.3's `SeatOrder`, its states `adr-payments.md` §8's and forward only (§7.3): a
 *   fact that would move it back is ignored, never applied. It owns its seats, created in its `paid`
 *   transition (adr-ticketing.md §11). A payment it can give no seat to is owed back (D-082).
 */
export class SeatOrder extends AggregateRoot<SeatOrderEvent> {
  private current: SeatOrderSnapshot;

  private constructor(current: SeatOrderSnapshot) {
    super();
    this.current = frozen(current);
  }

  public static restore(snapshot: SeatOrderSnapshot): SeatOrder {
    return new SeatOrder(snapshot);
  }

  public static place(placement: SeatOrderPlacement, now: Instant): SeatOrder {
    const order = new SeatOrder({
      ...structuredClone(placement),
      state: OrderState.PENDING,
      intent: null,
      failure: null,
      refund: null,
      intentCancelOwedAt: null,
      placedAt: now,
      paidAt: null,
      seats: [],
      version: 1,
    });
    order.apply(
      new SeatOrderPlaced(
        placement.id,
        placement.dateId,
        placement.holdId,
        placement.quote.total,
        now,
      ),
    );
    return order;
  }

  public get snapshot(): SeatOrderSnapshot {
    return this.current;
  }

  /** Still waiting for its money, and owing none back: a confirmation pays it. */
  public get acceptsPayment(): boolean {
    const { state, refund } = this.current;
    return refund === null && movesForward(state, OrderState.PAID);
  }

  /** Placed, and no intent created for it yet: the purchase resumes by creating one. */
  public get awaitsIntent(): boolean {
    const { state, intent } = this.current;
    return state === OrderState.PENDING && intent === null;
  }

  /**
   * Waiting for its buyer on an intent learnt of by its webhook alone, which carries no client
   *   secret: the purchase resumes by asking the provider, who hands the same intent back with it.
   */
  public get awaitsClientSecret(): boolean {
    const { intent, refund } = this.current;
    return this.awaitsPayment && refund === null && intent !== null && intent.clientSecret === null;
  }

  private get awaitsPayment(): boolean {
    return ORDER_STATES_AWAITING_PAYMENT.includes(this.current.state);
  }

  public get owesRefund(): boolean {
    const { refund, state } = this.current;
    return refund !== null && state !== OrderState.REFUNDED;
  }

  /** The hold it resumes on, its first one given back while the provider did not answer. */
  public renewHold(holdId: string, expiresAt: Instant, now: Instant): void {
    if (!this.awaitsIntent) throw new Error(`order ${this.current.id} holds no seats to renew`);
    this.advance({ holdId, expiresAt });
    this.apply(new SeatOrderHoldRenewed(this.current.id, holdId, expiresAt, now));
  }

  /**
   * An intent the provider created, still waiting for the buyer or the bank. An order that failed
   *   meanwhile keeps its state and owes the intent's cancellation; one already paid ignores it.
   */
  public recordIntent(
    intent: PaymentIntentRecord,
    state: typeof OrderState.AWAITING_ACTION | typeof OrderState.PROCESSING,
    now: Instant,
  ): void {
    const current = this.current;
    if (current.state === OrderState.FAILED) {
      this.advance({ intent: current.intent ?? intent, intentCancelOwedAt: now });
      return;
    }
    if (!this.awaitsPayment) return;
    const intentKnown = completedIntent(current.intent, intent);
    if (movesForward(current.state, state)) {
      this.advance({ state, intent: intentKnown });
      this.apply(new SeatOrderIntentRecorded(current.id, intent.ref, state, now));
    } else if (intentKnown !== current.intent) {
      this.advance({ intent: intentKnown });
    }
  }

  /** Paid, with one seat per seat bought; nothing when it cannot accept a payment any more. */
  public pay(intentRef: string, issues: readonly SeatIssue[], now: Instant): void {
    if (!this.acceptsPayment) return;
    const current = this.current;
    if (issues.length !== current.quantity) {
      throw new Error(
        `order ${current.id} buys ${String(current.quantity)} seats, not ${String(issues.length)}`,
      );
    }
    const seats = issues.map((issue): SeatSnapshot => ({
      id: issue.id,
      code: issue.code,
      tier: current.tier,
      state: SeatState.ACTIVE,
      cancelDeadline: issue.cancelDeadline,
      activatedAt: now,
    }));
    this.advance({
      state: OrderState.PAID,
      intent: current.intent ?? { ref: intentRef, clientSecret: null, nextAction: null },
      failure: null,
      intentCancelOwedAt: null,
      paidAt: now,
      seats,
    });
    this.apply(
      new SeatOrderPaid(
        current.id,
        current.dateId,
        current.channelId,
        current.accountId,
        current.profileId,
        current.tier,
        current.quote,
        intentRef,
        current.declaredTaxLocation,
        seats,
        now,
      ),
    );
  }

  /** False, changing nothing, once the order no longer waits for its payment. */
  public fail(failure: OrderFailure, now: Instant): boolean {
    const current = this.current;
    if (!this.awaitsPayment) return false;
    this.advance({ state: OrderState.FAILED, failure });
    this.apply(new SeatOrderFailed(current.id, current.dateId, failure.code, now));
    return true;
  }

  /** The provider took the money and no seat can be given: it goes back (D-082). */
  public oweRefund(reason: RefundReason, intentRef: string, now: Instant): void {
    if (!this.acceptsPayment) return;
    const current = this.current;
    this.advance({
      intent: current.intent ?? { ref: intentRef, clientSecret: null, nextAction: null },
      intentCancelOwedAt: null,
      refund: { reason, owedAt: now, ref: null, refundedAt: null },
    });
    this.apply(new SeatOrderRefundOwed(current.id, reason, now));
  }

  public markRefunded(refundRef: string, now: Instant): void {
    const { id, channelId, quote, refund } = this.current;
    if (refund === null || !this.owesRefund) return;
    this.advance({
      state: OrderState.REFUNDED,
      failure: null,
      refund: { ...refund, ref: refundRef, refundedAt: now },
    });
    this.apply(new SeatOrderRefunded(id, channelId, quote.total, refundRef, refund.reason, now));
  }

  public intentCancelled(): void {
    if (this.current.intentCancelOwedAt === null) return;
    this.advance({ intentCancelOwedAt: null });
  }

  private advance(changes: Partial<SeatOrderSnapshot>): void {
    this.current = frozen({
      ...this.current,
      ...structuredClone(changes),
      version: this.current.version + 1,
    });
  }
}
