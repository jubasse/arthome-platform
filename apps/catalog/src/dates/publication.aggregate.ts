import { AggregateRoot } from '@nestjs/cqrs';

import {
  DomainError,
  DomainErrorCode,
  PublicationPromise,
  PublicationState,
  assertCommandedTransition,
  publicationReadiness,
  type Instant,
  type PublicationChecklistItem,
  type PublicationTransitionCommand,
} from '@arthome/core';

import {
  PublicationEngaged,
  PublicationStateChanged,
  type PublicationEvent,
} from './publication.events.js';

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

/**
 * Core's `DomainError` takes scalar params, and this refusal names a list, as the contract's
 *   `{ missing: [...] }`: the list travels beside it.
 */
export class PublicationChecklistIncomplete extends DomainError {
  public constructor(public readonly missing: readonly PublicationChecklistItem[]) {
    super({ code: DomainErrorCode.PUBLICATION_CHECKLIST_INCOMPLETE });
  }
}

export interface TransitionContext {
  /** Every checklist item satisfied now: publishing needs each blocking one (§2.3). */
  readonly satisfied: readonly PublicationChecklistItem[];
  readonly now: Instant;
}

/** data-model.md §2.3, one per date. */
export class Publication extends AggregateRoot<PublicationEvent> {
  private constructor(private current: PublicationSnapshot) {
    super();
  }

  public static restore(snapshot: PublicationSnapshot): Publication {
    return new Publication(snapshot);
  }

  public static draft(dateId: string, channelId: string): Publication {
    return new Publication({
      dateId,
      channelId,
      state: PublicationState.DRAFT,
      version: 1,
      publishedAt: null,
      pricesLockedAt: null,
      replayOnlineAt: null,
    });
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

  /**
   * A commanded transition, when core's rules allow it and, to publish, the checklist is complete.
   *   Returns true when it published the date, which its date then makes public.
   */
  public transition(
    command: PublicationTransitionCommand,
    { satisfied, now }: TransitionContext,
  ): boolean {
    const publication = this.current;
    const { state: from, version } = publication;
    // Every caller may decide while tokens are not verified, as `publicationView` offers.
    const transition = assertCommandedTransition({ state: from, version }, command, true);
    // Publishing is the transition that engages the prices: `technical -> scheduled` also ends in
    // `scheduled` and is not one.
    const publishing = transition.irreversiblePromiseCode === PublicationPromise.PRICES_ENGAGED;
    if (publishing) {
      const { ready, missing } = publicationReadiness(satisfied);
      if (!ready) throw new PublicationChecklistIncomplete(missing);
    }

    this.current = {
      ...publication,
      state: command.to,
      version: version + 1,
      publishedAt: publishing ? (publication.publishedAt ?? now) : publication.publishedAt,
      pricesLockedAt: publishing ? (publication.pricesLockedAt ?? now) : publication.pricesLockedAt,
      replayOnlineAt:
        command.to === PublicationState.REPLAY_ONLINE ? now : publication.replayOnlineAt,
    };
    this.apply(
      new PublicationStateChanged(
        publication.dateId,
        publication.channelId,
        from,
        command.to,
        version + 1,
        transition.irreversiblePromiseCode !== null,
        now,
      ),
    );
    if (publishing) {
      this.apply(new PublicationEngaged(publication.dateId, publication.channelId, now));
    }
    return publishing;
  }
}
