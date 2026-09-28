import type { IdempotentRequest, MemorisedResponse } from '@arthome-platform/http-edge';
import { Command } from '@nestjs/cqrs';

import type { PaymentHandoffView, PurchasedSeats } from './order-views.js';
import type { PurchaseSeatBody } from './purchase-seat.schema.js';

/** 201 with the seats once paid; 202 with the handoff while the buyer or the bank still has to act. */
export const PurchaseStatus = { PAID: 201, AWAITING_PAYMENT: 202 } as const;
export type PurchaseStatus = (typeof PurchaseStatus)[keyof typeof PurchaseStatus];

export interface PurchaseAnswer {
  readonly status: PurchaseStatus;
  readonly response: MemorisedResponse<PurchasedSeats | PaymentHandoffView>;
}

export class PurchaseSeat extends Command<PurchaseAnswer> {
  public constructor(
    public readonly body: PurchaseSeatBody,
    public readonly traceparent: string | null,
    public readonly idempotency: IdempotentRequest,
  ) {
    super();
  }
}
