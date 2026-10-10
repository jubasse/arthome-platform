import type { IdempotentRequest, MemorisedResponse } from '@arthome-platform/http-edge';
import { Command } from '@nestjs/cqrs';

import type { Instant } from '@arthome/core';

import type { DateSalesPane } from './date-sales-pane.js';
import type { OpenCapacityTierBody } from './open-capacity-tier.schema.js';

export interface OpenedCapacityTier {
  readonly sales: DateSalesPane;
  /** The accounts named in `waitlist.notified`; 0 when the tier went on public sale. */
  readonly waitlistNotified: number;
  /** The window opened or extended; absent when nobody was notified. */
  readonly priorityUntil?: Instant;
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
