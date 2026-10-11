import type { IEvent } from '@nestjs/cqrs';

import type { Instant } from '@arthome/core';

import type { CreditSnapshot } from './credit.aggregate.js';

export class CreditIssued implements IEvent {
  public readonly kind = 'CreditIssued';

  public constructor(
    public readonly credit: CreditSnapshot,
    public readonly occurredAt: Instant,
  ) {}
}

/**
 * Every event of the aggregate. A mapping switches on `kind` and ends in `assertNever`, so an event
 *   without its case fails to compile rather than reach the wire as another.
 */
export type CreditEvent = CreditIssued;
