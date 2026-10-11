import type { PerishableResponse } from '@arthome-platform/http-edge';
import { Query } from '@nestjs/cqrs';

import type { QuoteSeatBody } from './quote-seat.schema.js';
import type { SeatQuoteView } from './seat-quote-view.js';

/** The storefront's `quoteSeat`: a read, though a `POST`, since its criteria fit no URL. */
export class QuoteSeat extends Query<PerishableResponse<SeatQuoteView>> {
  public constructor(
    public readonly dateId: string,
    public readonly body: QuoteSeatBody,
    public readonly accountId: string,
  ) {
    super();
  }
}
