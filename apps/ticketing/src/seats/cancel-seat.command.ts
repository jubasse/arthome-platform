import type { IdempotentRequest, MemorisedResponse } from '@arthome-platform/http-edge';
import { Command } from '@nestjs/cqrs';

import type { TicketView } from '../orders/order-views.js';

/** `cancelSeat`'s 200 but the `date`, which the BFF adds with the ticket's own. */
export interface SeatCancellationView {
  readonly ticket: TicketView;
}

export class CancelSeat extends Command<MemorisedResponse<SeatCancellationView>> {
  public constructor(
    public readonly seatId: string,
    /** The internal token's: a seat is cancelled by its buyer alone. */
    public readonly accountId: string,
    public readonly traceparent: string | null,
    public readonly idempotency: IdempotentRequest,
  ) {
    super();
  }
}
