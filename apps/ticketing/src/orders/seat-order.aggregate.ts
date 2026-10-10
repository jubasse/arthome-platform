import { frozen } from '@arthome-platform/transactions';
import { AggregateRoot } from '@nestjs/cqrs';
import { v7 as uuidv7 } from 'uuid';

import {
  DomainError,
  OrderErrorCode,
  assertRefundWithinRemaining,
  compare,
  type Instant,
  type Money,
  type PriceTier,
  type RefundReason,
  type OrderQuote as CoreOrderQuote,
  OrderState,
  type SeatCancelReason,
  SeatState,
  orderStateMovesForward,
  refundIdempotencyKey,
  refundableRemaining,
  seatStateMayMove,
  subtract,
  sum,
} from '@arthome/core';

import { ORDER_STATES_AWAITING_PAYMENT } from './awaiting-payment.js';
import {
  SeatCancelled,
  SeatOrderFailed,
  SeatOrderHoldRenewed,
  SeatOrderIntentRecorded,
  SeatOrderPaid,
  SeatOrderPlaced,
  SeatOrderRefundOwed,
  SeatOrderRefunded,
  SeatsCredited,
  type SeatOrderEvent,
} from './seat-order.events.js';
import { type NextAction } from '../payments/next-action.js';

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
  /** When it left `active`. */
  readonly endedAt: Instant | null;
  readonly cancelReason: SeatCancelReason | null;
  /** The refund giving its money back, `refunded` once made; null when nothing was given back. */
  readonly refundId: string | null;
  readonly refundAmount: Money | null;
  readonly creditId: string | null;
  readonly creditAmount: Money | null;
}

/**
 * Seats cancelled at once, PT1's and PT2's one transition: each with its share of `refundId`, or
 *   with nothing given back when the refund is null or its share is nothing.
 */
export interface SeatCancellation {
  readonly reason: SeatCancelReason;
  readonly refundId: string | null;
  readonly seats: readonly { readonly seatId: string; readonly refundAmount: Money | null }[];
}

/** Seats exchanged for a credit on the account (PT1, an interrupted date). */
export interface SeatCrediting {
  readonly creditId: string;
  readonly seats: readonly { readonly seatId: string; readonly creditAmount: Money }[];
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

/** A refund its caller decided; the key is the caller's too, core's `refundIdempotencyKey(id)`. */
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

function sameRefund(owed: OrderRefund, refund: OwedRefund): boolean {
  return (
    owed.id === refund.id &&
    owed.idempotencyKey === refund.idempotencyKey &&
    owed.reason === refund.reason &&
    owed.seatId === refund.seatId &&
    owed.amount.currencyCode === refund.amount.currencyCode &&
    owed.amount.amountMinor === refund.amount.amountMinor
  );
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
    return refundableRemaining(
      quote.total,
      sum(
        refunds.map(({ amount }) => amount),
        quote.total.currencyCode,
      ),
    );
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
      endedAt: null,
      cancelReason: null,
      refundId: null,
      refundAmount: null,
      creditId: null,
      creditAmount: null,
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

  /**
   * Money taken and still held, owed back in part or in whole; the worker's queue makes it. Owed
   *   again with the same facts, a replay, it answers the refund already owed and changes nothing;
   *   its id or its key already owed with other facts is refused.
   */
  public oweRefund(refund: OwedRefund, now: Instant): OrderRefund {
    const current = this.current;
    const owed = current.refunds.find(
      ({ id, idempotencyKey }) => id === refund.id || idempotencyKey === refund.idempotencyKey,
    );
    if (owed !== undefined) {
      if (sameRefund(owed, refund)) return owed;
      throw new Error(
        `order ${current.id} already owes refund ${owed.id} under ${owed.idempotencyKey}, ` +
          `not refund ${refund.id} under ${refund.idempotencyKey}`,
      );
    }
    if (!STATES_OWING_REFUNDS.includes(current.state)) {
      throw new Error(`order ${current.id} is ${current.state}: it holds no money to refund`);
    }
    if (refund.amount.amountMinor <= 0) {
      throw new Error(`order ${current.id} cannot owe a refund of nothing`);
    }
    assertRefundWithinRemaining(refund.amount, this.refundableLeft);
    return this.owe(refund, now, {});
  }

  /**
   * The provider took the money and no seat can be given: all of it goes back (D-082). The refund's
   *   id, or null when the order takes no payment any more.
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
        idempotencyKey: refundIdempotencyKey(id),
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
   *   `partially_refunded` before, forward only, and the seats it gives back `refunded`. Nothing
   *   for one already made.
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
      seats: current.seats.map((seat) =>
        seat.refundId === refundId && seatStateMayMove(seat.state, SeatState.REFUNDED)
          ? { ...seat, state: SeatState.REFUNDED }
          : seat,
      ),
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

  /**
   * A refund webhook's cumulative amount says how much was refunded, not which refunds: it marks
   *   none made (R15, replaced). The refunds still owed that the amount no refund made explains
   *   could cover, whose calls to re-run now; null past every refund the order holds, a refund
   *   made outside the platform.
   */
  public refundsTheProviderMayHaveMade(amountRefunded: Money): readonly string[] | null {
    const { refunds, quote } = this.current;
    const currencyCode = quote.total.currencyCode;
    const amountsOf = (held: readonly OrderRefund[]) =>
      sum(
        held.map(({ amount }) => amount),
        currencyCode,
      );
    if (compare(amountRefunded, amountsOf(refunds)) > 0) return null;
    const unmade = refunds.filter(({ refundedAt }) => refundedAt === null);
    const made = refunds.filter(({ refundedAt }) => refundedAt !== null);
    const unexplained = subtract(amountRefunded, amountsOf(made));
    return unmade.filter(({ amount }) => compare(amount, unexplained) <= 0).map(({ id }) => id);
  }

  /**
   * Each seat `cancelled` at once with its share of the refund, `refunded` when that refund is
   *   made; one `SeatCancelled` each. A seat no longer active is refused `seat.not_active`,
   *   naming its state, and nothing moves.
   */
  public cancelSeats({ reason, refundId, seats }: SeatCancellation, now: Instant): void {
    const current = this.current;
    const refund = current.refunds.find(({ id }) => id === refundId);
    if (refundId !== null && refund === undefined) {
      throw new Error(`order ${current.id} owes no refund ${refundId}`);
    }
    const givenBack = seats.flatMap(({ refundAmount }) =>
      refundAmount === null ? [] : [refundAmount],
    );
    if (
      refund !== undefined &&
      compare(sum(givenBack, refund.amount.currencyCode), refund.amount) > 0
    ) {
      throw new Error(`order ${current.id}: the seats' shares exceed refund ${refund.id}`);
    }
    if (refundId === null && seats.some(({ refundAmount }) => refundAmount !== null)) {
      throw new Error(`order ${current.id} cannot give a seat a share of no refund`);
    }
    this.assertSeatsMayMove(
      seats.map(({ seatId }) => seatId),
      SeatState.CANCELLED,
    );
    const shares = new Map(seats.map(({ seatId, refundAmount }) => [seatId, refundAmount]));
    this.advance({
      seats: current.seats.map((seat) => {
        if (!shares.has(seat.id)) return seat;
        const share = shares.get(seat.id) ?? null;
        const givenBack = share !== null && share.amountMinor > 0 ? share : null;
        return {
          ...seat,
          state: SeatState.CANCELLED,
          endedAt: now,
          cancelReason: reason,
          refundId: givenBack === null ? null : refundId,
          refundAmount: givenBack,
        };
      }),
    });
    for (const { seatId } of seats) {
      this.apply(
        new SeatCancelled(current.id, current.dateId, seatId, current.accountId, reason, now),
      );
    }
  }

  /** Each seat `credited` with its share of the credit; `seat.not_active` as `cancelSeats`. */
  public creditSeats({ creditId, seats }: SeatCrediting, now: Instant): void {
    const current = this.current;
    this.assertSeatsMayMove(
      seats.map(({ seatId }) => seatId),
      SeatState.CREDITED,
    );
    const shares = new Map(seats.map(({ seatId, creditAmount }) => [seatId, creditAmount]));
    this.advance({
      seats: current.seats.map((seat) => {
        const share = shares.get(seat.id);
        if (share === undefined) return seat;
        return { ...seat, state: SeatState.CREDITED, endedAt: now, creditId, creditAmount: share };
      }),
    });
    this.apply(
      new SeatsCredited(
        current.id,
        current.dateId,
        creditId,
        seats.map(({ seatId }) => seatId),
        now,
      ),
    );
  }

  /**
   * The buyer's bank disputed the charge: the provider holds the money, so no refund is owed any
   *   more, and the seats stay active, "nothing on the viewer's side" (adr-payments.md §9). False
   *   once disputed.
   */
  public dispute(): boolean {
    if (!orderStateMovesForward(this.current.state, OrderState.DISPUTED)) return false;
    this.advance({ state: OrderState.DISPUTED, failure: null });
    return true;
  }

  public intentCancelled(): void {
    if (this.current.intentCancelOwedAt === null) return;
    this.advance({ intentCancelOwedAt: null });
  }

  private owe(refund: OwedRefund, now: Instant, changes: Partial<SeatOrderSnapshot>): OrderRefund {
    const current = this.current;
    const owed: OrderRefund = { ...refund, owedAt: now, ref: null, refundedAt: null };
    this.advance({ ...changes, refunds: [...current.refunds, owed] });
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
    return owed;
  }

  /** Each seat named once, held by the order and allowed to move to `to`: else nothing moves. */
  private assertSeatsMayMove(seatIds: readonly string[], to: SeatState): void {
    const current = this.current;
    if (new Set(seatIds).size !== seatIds.length) {
      throw new Error(`order ${current.id}: a seat is named twice`);
    }
    for (const seatId of seatIds) {
      const seat = current.seats.find(({ id }) => id === seatId);
      if (seat === undefined) throw new Error(`order ${current.id} holds no seat ${seatId}`);
      if (!seatStateMayMove(seat.state, to)) {
        throw new DomainError({
          code: OrderErrorCode.SEAT_NOT_ACTIVE,
          params: { state: seat.state },
        });
      }
    }
  }

  private advance(changes: Partial<SeatOrderSnapshot>): void {
    this.current = frozen({
      ...this.current,
      ...structuredClone(changes),
      version: this.current.version + 1,
    });
  }
}
