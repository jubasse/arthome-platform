import type { IdempotentRequest, MemorisedResponse } from '@arthome-platform/http-edge';
import { Command } from '@nestjs/cqrs';

import type { DateSalesPane } from './date-sales-pane.js';
import type { SetDatePricesBody } from './set-date-prices.schema.js';

export class SetDatePrices extends Command<MemorisedResponse<DateSalesPane>> {
  public constructor(
    public readonly dateId: string,
    public readonly body: SetDatePricesBody,
    public readonly traceparent: string | null,
    public readonly idempotency: IdempotentRequest,
  ) {
    super();
  }
}
