import type { IdempotentRequest, MemorisedResponse } from '@arthome-platform/http-edge';
import { Command } from '@nestjs/cqrs';

import type { DateSalesPane } from './date-sales-pane.js';
import type { OpenCapacityTierBody } from './open-capacity-tier.schema.js';

export interface OpenedCapacityTier {
  readonly sales: DateSalesPane;
  /** No waiting list exists before T5, so nobody is notified; `priorityUntil` is absent with it. */
  readonly waitlistNotified: number;
}

export class OpenCapacityTier extends Command<MemorisedResponse<OpenedCapacityTier>> {
  public constructor(
    public readonly dateId: string,
    public readonly body: OpenCapacityTierBody,
    public readonly traceparent: string | null,
    public readonly idempotency: IdempotentRequest,
  ) {
    super();
  }
}
