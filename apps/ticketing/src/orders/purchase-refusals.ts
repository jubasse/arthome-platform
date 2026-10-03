import { RefusalException } from '@arthome-platform/http-edge';
import { HttpStatus } from '@nestjs/common';

import {
  ApiErrorCode,
  FailureNature,
  OrderErrorCode,
  type Instant,
  type Money,
  type MessageParams,
  type LateEntry,
} from '@arthome/core';

import type { SeatOrderSnapshot } from './seat-order.aggregate.js';

/** How long a purchase waits on another one holding its key before being told it is in flight. */
export const KEY_HOLDER_WAIT_MS = 5_000;
const RETRY_AFTER_MS = 1_000;

function refused(code: string, params: MessageParams = {}): RefusalException {
  return new RefusalException(HttpStatus.CONFLICT, { code, params, nature: FailureNature.REFUSED });
}

/** A body naming a profile the internal token does not: the buyer is the token's (review m6). */
export function notTheCallersProfile(): RefusalException {
  return new RefusalException(HttpStatus.FORBIDDEN, {
    code: ApiErrorCode.FORBIDDEN,
    params: {},
    nature: FailureNature.REFUSED,
  });
}

export function soldOut(): RefusalException {
  return refused(OrderErrorCode.SOLD_OUT);
}

/**
 * Past the sale's end by time, thirty minutes after the start (D-089): ended, not sold out, which
 *   is the waiting list's cue.
 */
export function salesClosed(salesEndAt: Instant): RefusalException {
  return refused(OrderErrorCode.SALES_CLOSED, { salesEndAt });
}

/** The storefront contract's params: what the surface showed, and the price now, when there is one. */
export function priceStale(expected: Money, current: Money | null): RefusalException {
  return refused(OrderErrorCode.PRICE_STALE, {
    expectedAmountMinor: expected.amountMinor,
    ...(current !== null && { currentAmountMinor: current.amountMinor }),
    currencyCode: current?.currencyCode ?? expected.currencyCode,
  });
}

/**
 * After the start, a purchase that did not acknowledge the part of the live already missed, with
 *   the facts the surface warns with (D-089).
 */
export function lateEntryUnacknowledged({
  startedAt,
  minutesElapsed,
  salesEndAt,
}: LateEntry): RefusalException {
  return refused(OrderErrorCode.LATE_ENTRY_UNACKNOWLEDGED, {
    startedAt,
    minutesElapsed,
    salesEndAt,
  });
}

export function keyReused(): RefusalException {
  return refused(ApiErrorCode.IDEMPOTENCY_KEY_REUSED);
}

export function keyInFlight(): RefusalException {
  return new RefusalException(HttpStatus.CONFLICT, {
    code: ApiErrorCode.IDEMPOTENCY_IN_FLIGHT,
    params: { retryAfterMs: RETRY_AFTER_MS },
    nature: FailureNature.UNAVAILABLE,
  });
}

/** The provider did not answer: its hold given back, the purchase retried under the same key. */
export function paymentUnavailable(cause: unknown): RefusalException {
  return new RefusalException(
    HttpStatus.SERVICE_UNAVAILABLE,
    { code: ApiErrorCode.SERVICE_UNAVAILABLE, params: {}, nature: FailureNature.UNAVAILABLE },
    { cause },
  );
}

/**
 * What a purchase whose order ended without seats answers, first time or replayed: the decline and
 *   its code, and otherwise sold out, since the seats it held went back, or its money did (D-082).
 */
export function refusalOfUnpaid(
  order: SeatOrderSnapshot,
  salesEndAt: Instant | null,
): RefusalException {
  const { failure } = order;
  if (failure?.code === OrderErrorCode.PAYMENT_DECLINED) {
    return refused(OrderErrorCode.PAYMENT_DECLINED, {
      ...(failure.declineCode !== null && { declineCode: failure.declineCode }),
    });
  }
  if (failure?.code === OrderErrorCode.SALES_CLOSED && salesEndAt !== null)
    return salesClosed(salesEndAt);
  return soldOut();
}
