import type { IdempotentRequest, MemorisedResponse } from '@arthome-platform/http-edge';
import { Command } from '@nestjs/cqrs';

import type { DateSalesPane } from './date-sales-pane.js';
import type { SetTechnicalProvisionBody } from './set-technical-provision.schema.js';

export class SetTechnicalProvision extends Command<MemorisedResponse<DateSalesPane>> {
  public constructor(
    public readonly dateId: string,
    public readonly body: SetTechnicalProvisionBody,
    public readonly traceparent: string | null,
    public readonly idempotency: IdempotentRequest,
  ) {
    super();
  }
}
