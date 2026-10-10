import type { Outcome } from '@arthome-platform/messaging';
import { Command } from '@nestjs/cqrs';

import type { PlanOpening, PlanTier, SubscriptionState } from '@arthome/core';

import type { Delivery } from '../delivery.js';

/** `ticketing.subscription.changed.v1`, its unknown members already kept out (R7). */
export interface SubscriptionFact {
  readonly type: 'ticketing.subscription.changed.v1';
  readonly accountId: string;
  readonly plan: PlanTier | null;
  readonly state: SubscriptionState | null;
  readonly openings: readonly PlanOpening[];
  /** The end of the last paid period, what `planOpeningsOf` reads (D-125); null when none was paid. */
  readonly paidThrough: Date | null;
  readonly statedAt: Date;
}

export class RecordSubscriptionFact extends Command<Outcome> {
  public constructor(
    public readonly delivery: Delivery,
    public readonly fact: SubscriptionFact,
  ) {
    super();
  }
}
