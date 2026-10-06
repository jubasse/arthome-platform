import { frozen } from '@arthome-platform/transactions';
import { AggregateRoot } from '@nestjs/cqrs';
import { v7 as uuidv7 } from 'uuid';

import {
  compare,
  type Instant,
  type Money,
  type PriceTier,
  type RefundReason,
  type OrderQuote as CoreOrderQuote,
  OrderState,
  SeatState,
  orderStateMovesForward,
  subtract,
  sum,
  type OrderErrorCode,
} from '@arthome/core';

import { ORDER_STATES_AWAITING_PAYMENT } from './awaiting-payment.js';
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
import { type NextAction } from '../payments/next-action.js';
import { refundKeyOf } from '../payments/refund-ledger.js';

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

/** A refund its caller decided; the key is the caller's too, `refundIdempotencyKey(id)` (C1). */
export interface OwedRefund {
  readonly id: string;
  readonly amount: Money;
  readonly reason: RefundReason;
  readonly idempotencyKey: string;
  readonly seatId: string | null;
}

export interface OrderRefund extends OwedRefund {
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
  /** In the order they were owed, made or not. */
  readonly refunds: readonly OrderRefund[];
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

/** The money was taken and is still held, in part at least. */
const STATES_OWING_REFUNDS: readonly OrderState[] = [
  OrderState.PAID,
  OrderState.PARTIALLY_REFUNDED,
];

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
      refunds: [],
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
    const { state, refunds } = this.current;
    return refunds.length === 0 && orderStateMovesForward(state, OrderState.PAID);
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
    const { intent, refunds } = this.current;
    return (
      this.awaitsPayment && refunds.length === 0 && intent !== null && intent.clientSecret === null
    );
  }

  private get awaitsPayment(): boolean {
    return ORDER_STATES_AWAITING_PAYMENT.includes(this.current.state);
  }

  public get owesRefund(): boolean {
    return this.current.refunds.some(({ refundedAt }) => refundedAt === null);
  }

  /** The total less every refund owed or made. */
  public get refundableLeft(): Money {
    const { quote, refunds } = this.current;
    const owed = sum(
      refunds.map(({ amount }) => amount),
      quote.total.currencyCode,
    );
    return subtract(quote.total, owed);
  }

  /** The hold it resumes on, its first one given back while the provider did not answer. */
  public renewHold(holdId: string, expiresAt: Instant, now: Instant): void {
    if (!this.awaitsIntent) throw new Error(`order ${this.current.id} holds no seats to renew`);
    this.advance({ holdId, expiresAt });
    this.apply(new SeatOrderHoldRenewed(this.current.id, holdId, expiresAt, now));
  }

  /**
   * An intent the provider created, still waiting for the buyer or the bank. One already paid
   *   ignores it. True when the order failed meanwhile: it keeps its state and owes the intent's
   *   cancellation, from the instant it first owed it, and the caller starts its attempts over.
   */
  public recordIntent(
    intent: PaymentIntentRecord,
    state: typeof OrderState.AWAITING_ACTION | typeof OrderState.PROCESSING,
    now: Instant,
  ): boolean {
    const current = this.current;
    if (current.state === OrderState.FAILED) {
      this.advance({
        intent: current.intent ?? intent,
        intentCancelOwedAt: current.intentCancelOwedAt ?? now,
      });
      return true;
    }
    if (!this.awaitsPayment) return false;
    const intentKnown = completedIntent(current.intent, intent);
    if (orderStateMovesForward(current.state, state)) {
      this.advance({ state, intent: intentKnown });
      this.apply(new SeatOrderIntentRecorded(current.id, intent.ref, state, now));
    } else if (intentKnown !== current.intent) {
      this.advance({ intent: intentKnown });
    }
    return false;
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

  /** Money taken and still held, owed back in part or in whole; the worker's queue makes it. */
  public oweRefund(refund: OwedRefund, now: Instant): void {
    const current = this.current;
    if (!STATES_OWING_REFUNDS.includes(current.state)) {
      throw new Error(`order ${current.id} is ${current.state}: it holds no money to refund`);
    }
    const left = this.refundableLeft;
    if (refund.amount.amountMinor <= 0 || compare(refund.amount, left) > 0) {
      throw new Error(
        `order ${current.id} cannot owe ${String(refund.amount.amountMinor)} back: ` +
          `${String(left.amountMinor)} ${left.currencyCode} is left to refund`,
      );
    }
    this.owe(refund, now, {});
  }

  /**
   * The provider took the money and no seat can be given: all of it goes back (D-082), under the
   *   order's key. The refund's id, or null when the order takes no payment any more.
   */
  public oweUnseatedPaymentBack(
    reason: RefundReason,
    intentRef: string,
    now: Instant,
  ): string | null {
    if (!this.acceptsPayment) return null;
    const current = this.current;
    const id = uuidv7();
    this.owe(
      {
        id,
        amount: current.quote.total,
        reason,
        idempotencyKey: refundKeyOf(current.id),
        seatId: null,
      },
      now,
      {
        intent: current.intent ?? { ref: intentRef, clientSecret: null, nextAction: null },
        intentCancelOwedAt: null,
      },
    );
    return id;
  }

  /**
   * A refund the provider made: `refunded` once the refunds made reach the total,
   *   `partially_refunded` before, forward only. Nothing for one already made.
   */
  public refundMade(refundId: string, refundRef: string, now: Instant): void {
    const current = this.current;
    const refund = current.refunds.find(({ id }) => id === refundId);
    if (refund === undefined) throw new Error(`order ${current.id} owes no refund ${refundId}`);
    if (refund.refundedAt !== null) return;
    const refunds = current.refunds.map((owed) =>
      owed.id === refundId ? { ...owed, ref: refundRef, refundedAt: now } : owed,
    );
    const made = sum(
      refunds.filter(({ refundedAt }) => refundedAt !== null).map(({ amount }) => amount),
      current.quote.total.currencyCode,
    );
    const reached =
      compare(made, current.quote.total) >= 0 ? OrderState.REFUNDED : OrderState.PARTIALLY_REFUNDED;
    this.advance({
      refunds,
      ...(orderStateMovesForward(current.state, reached) && { state: reached, failure: null }),
    });
    this.apply(
      new SeatOrderRefunded(
        current.id,
        current.channelId,
        refundId,
        refund.amount,
        refundRef,
        refund.reason,
        now,
      ),
    );
  }

  public intentCancelled(): void {
    if (this.current.intentCancelOwedAt === null) return;
    this.advance({ intentCancelOwedAt: null });
  }

  private owe(refund: OwedRefund, now: Instant, changes: Partial<SeatOrderSnapshot>): void {
    const current = this.current;
    this.advance({
      ...changes,
      refunds: [...current.refunds, { ...refund, owedAt: now, ref: null, refundedAt: null }],
    });
    this.apply(
      new SeatOrderRefundOwed(
        current.id,
        refund.id,
        refund.amount,
        refund.reason,
        refund.seatId,
        now,
      ),
    );
  }

  private advance(changes: Partial<SeatOrderSnapshot>): void {
    this.current = frozen({
      ...this.current,
      ...structuredClone(changes),
      version: this.current.version + 1,
    });
  }
}
