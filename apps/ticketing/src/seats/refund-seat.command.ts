import type { IdempotentRequest, MemorisedResponse } from '@arthome-platform/http-edge';
import { Command } from '@nestjs/cqrs';

import type { Money } from '@arthome/core';

import type { RefundSeatBody } from './refund-seat.schema.js';

/**
 * `refundSeat`'s 200. `commissionRefunded` is absent and `payoutId` null until payouts own the
 *   payout: the commission is taken on the net of tax, which awaits counsel (adr-payments.md §5.5).
 */
export interface SeatRefundView {
  readonly refunded: Money;
  readonly payoutId: null;
}

export class RefundSeat extends Command<MemorisedResponse<SeatRefundView>> {
  public constructor(
    public readonly seatId: string,
    public readonly body: RefundSeatBody,
    /** `If-Rights-Version`, parsed; its check against the operator's rights is auth slice B's. */
    public readonly rightsVersion: number | null,
    public readonly traceparent: string | null,
    public readonly idempotency: IdempotentRequest,
  ) {
    super();
  }
}
