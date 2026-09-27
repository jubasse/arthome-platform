import { AggregateRoot, type IEvent } from '@nestjs/cqrs';

import { DomainError, DomainErrorCode, type Instant, type PublicationState } from '@arthome/core';

export interface PublicationSnapshot {
  readonly dateId: string;
  readonly channelId: string;
  readonly state: PublicationState;
  /** The version the studio's sheet serves: every command on the date is conditioned on it. */
  readonly version: number;
  readonly publishedAt: Instant | null;
  readonly pricesLockedAt: Instant | null;
  readonly replayOnlineAt: Instant | null;
}

/** data-model.md §2.3, one per date. */
export class Publication extends AggregateRoot<IEvent> {
  private constructor(private current: PublicationSnapshot) {
    super();
  }

  public static restore(snapshot: PublicationSnapshot): Publication {
    return new Publication(snapshot);
  }

  public get snapshot(): PublicationSnapshot {
    return this.current;
  }

  /**
   * Refuses a screen that read another version, with the current state and version, then counts
   *   one more change: a screen that did not see this one is stale like any other.
   */
  public advanceVersionFrom(expectedVersion: number): void {
    const { state, version } = this.current;
    if (version !== expectedVersion) {
      throw new DomainError({ code: DomainErrorCode.STATE_CONFLICT, params: { state, version } });
    }
    this.current = { ...this.current, version: version + 1 };
  }
}
