import { Query } from '@nestjs/cqrs';

import type { OrderDetail } from './order-views.js';

/** The storefront's `getOrder`: the only truth after a payment, polled on the buyer's return. */
export class GetOrder extends Query<OrderDetail> {
  public constructor(
    public readonly orderId: string,
    public readonly accountId: string,
  ) {
    super();
  }
}
