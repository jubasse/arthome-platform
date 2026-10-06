import type { IEvent } from '@nestjs/cqrs';

import {
  type Instant,
  type Money,
  type PriceTier,
  type RefundReason,
  type OrderErrorCode,
  type OrderState,
  type SeatCancelReason,
} from '@arthome/core';

import type { DeclaredTaxLocation, OrderQuote, SeatSnapshot } from './seat-order.aggregate.js';

export class SeatOrderPlaced implements IEvent {
  public readonly kind = 'SeatOrderPlaced';

  public constructor(
    public readonly orderId: string,
    public readonly dateId: string,
    public readonly holdId: string,
    public readonly total: Money,
    public readonly occurredAt: Instant,
  ) {}
}

/** Its hold given back while the provider did not answer, the order held seats again to resume. */
export class SeatOrderHoldRenewed implements IEvent {
  public readonly kind = 'SeatOrderHoldRenewed';

  public constructor(
    public readonly orderId: string,
    public readonly holdId: string,
    public readonly expiresAt: Instant,
    public readonly occurredAt: Instant,
  ) {}
}

export class SeatOrderIntentRecorded implements IEvent {
  public readonly kind = 'SeatOrderIntentRecorded';

  public constructor(
    public readonly orderId: string,
    public readonly intentRef: string,
    public readonly state: OrderState,
    public readonly occurredAt: Instant,
  ) {}
}

/** The seats exist from here (D-077), one per seat bought. */
export class SeatOrderPaid implements IEvent {
  public readonly kind = 'SeatOrderPaid';

  public constructor(
    public readonly orderId: string,
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly accountId: string | null,
    public readonly profileId: string | null,
    public readonly tier: PriceTier,
    public readonly quote: OrderQuote,
    public readonly intentRef: string,
    public readonly declaredTaxLocation: DeclaredTaxLocation | null,
    public readonly seats: readonly SeatSnapshot[],
    public readonly occurredAt: Instant,
  ) {}
}

export class SeatOrderFailed implements IEvent {
  public readonly kind = 'SeatOrderFailed';

  public constructor(
    public readonly orderId: string,
    public readonly dateId: string,
    /** Null when it failed for want of a payment: its hold expired, its intent was cancelled. */
    public readonly failureCode: OrderErrorCode | null,
    public readonly occurredAt: Instant,
  ) {}
}

/** A refund owed, made by the worker's queue; D-082's is the whole payment, with no seat to give. */
export class SeatOrderRefundOwed implements IEvent {
  public readonly kind = 'SeatOrderRefundOwed';

  public constructor(
    public readonly orderId: string,
    public readonly refundId: string,
    public readonly amount: Money,
    public readonly reason: RefundReason,
    public readonly seatId: string | null,
    public readonly occurredAt: Instant,
  ) {}
}

/** One refund made, of several an order may owe. */
export class SeatOrderRefunded implements IEvent {
  public readonly kind = 'SeatOrderRefunded';

  public constructor(
    public readonly orderId: string,
    public readonly channelId: string,
    public readonly refundId: string,
    public readonly amount: Money,
    /** Null for a refund a webhook's cumulative amount showed made before the provider named it. */
    public readonly refundRef: string | null,
    public readonly reason: RefundReason,
    public readonly occurredAt: Instant,
  ) {}
}

/** One seat out of `active`, its refund made later if it has one. */
export class SeatCancelled implements IEvent {
  public readonly kind = 'SeatCancelled';

  public constructor(
    public readonly orderId: string,
    public readonly dateId: string,
    public readonly seatId: string,
    public readonly accountId: string | null,
    public readonly reason: SeatCancelReason,
    public readonly occurredAt: Instant,
  ) {}
}

/** Seats exchanged for a credit; no wire, since no `SeatCancelReason` member fits (D-092). */
export class SeatsCredited implements IEvent {
  public readonly kind = 'SeatsCredited';

  public constructor(
    public readonly orderId: string,
    public readonly dateId: string,
    public readonly creditId: string,
    public readonly seatIds: readonly string[],
    public readonly occurredAt: Instant,
  ) {}
}

/**
 * Every event of the aggregate. A mapping switches on `kind` and ends in `assertNever`, so an
 *   event without its case fails to compile rather than reach the wire as another.
 */
export type SeatOrderEvent =
  | SeatOrderPlaced
  | SeatOrderHoldRenewed
  | SeatOrderIntentRecorded
  | SeatOrderPaid
  | SeatOrderFailed
  | SeatOrderRefundOwed
  | SeatOrderRefunded
  | SeatCancelled
  | SeatsCredited;
