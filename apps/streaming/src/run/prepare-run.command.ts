import type { Outcome } from '@arthome-platform/messaging';
import { Command } from '@nestjs/cqrs';

import type { Delivery } from '../delivery.js';

/** What `catalog.date.drafted.v1` states, at its `occurred_at`. */
export interface DateDraftedFact {
  readonly dateId: string;
  readonly channelId: string;
  readonly occurredAt: Date;
}

/** Dispatched by the consumer, once per `catalog.date.drafted.v1` it reads. */
export class PrepareRun extends Command<Outcome> {
  public constructor(
    public readonly delivery: Delivery,
    public readonly fact: DateDraftedFact,
  ) {
    super();
  }
}
