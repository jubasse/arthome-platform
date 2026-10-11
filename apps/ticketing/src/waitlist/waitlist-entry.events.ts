import type { IEvent } from '@nestjs/cqrs';

import type { Instant, WaitlistEntryState } from '@arthome/core';

/** `notified` with the window it joined, which `waitlist.notified` names it into. */
export class WaitlistJoined implements IEvent {
  public readonly kind = 'WaitlistJoined';

  public constructor(
    public readonly entryId: string,
    public readonly dateId: string,
    public readonly accountId: string,
    public readonly state: WaitlistEntryState,
    public readonly priorityUntil: Instant | null,
    public readonly occurredAt: Instant,
  ) {}
}

export class WaitlistLeft implements IEvent {
  public readonly kind = 'WaitlistLeft';

  public constructor(
    public readonly entryId: string,
    public readonly dateId: string,
    public readonly accountId: string,
    public readonly occurredAt: Instant,
  ) {}
}

/**
 * Every event of the aggregate. A mapping switches on `kind` and ends in `assertNever`, so an event
 *   without its case fails to compile rather than reach the wire as another.
 */
export type WaitlistEntryEvent = WaitlistJoined | WaitlistLeft;
