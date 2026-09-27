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

import { PublicationEngaged, PublicationStateChanged } from './performance-date.events.js';

export interface PublicationSnapshot {
  readonly dateId: string;
  readonly channelId: string;
  readonly state: PublicationState;
  /** The date aggregate's version, the one the studio's sheet serves and every command names. */
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

export interface PublicationTransitioned {
  readonly publication: Publication;
  readonly changed: PublicationStateChanged;
  /** Null for every transition but the one that publishes. */
  readonly engaged: PublicationEngaged | null;
}

/**
 * data-model.md §2.3, an entity of the `PerformanceDate` aggregate (D-085), which alone calls it.
 *   Each decision returns the publication it leads to, so a refusal later in the same command leaves
 *   the aggregate as it was.
 */
export class Publication {
  private constructor(public readonly snapshot: PublicationSnapshot) {}

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

  /**
   * Refuses a screen that read another version, with the current state and version, then counts
   *   one more change: a screen that did not see this one is stale like any other.
   */
  public advancedFrom(expectedVersion: number): Publication {
    const { state, version } = this.snapshot;
    if (version !== expectedVersion) {
      throw new DomainError({ code: DomainErrorCode.STATE_CONFLICT, params: { state, version } });
    }
    return new Publication({ ...this.snapshot, version: version + 1 });
  }

  /** A commanded transition, when core's rules allow it and, to publish, the checklist is complete. */
  public transitioned(
    command: PublicationTransitionCommand,
    satisfied: readonly PublicationChecklistItem[],
    now: Instant,
  ): PublicationTransitioned {
    const publication = this.snapshot;
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

    return {
      publication: new Publication({
        ...publication,
        state: command.to,
        version: version + 1,
        publishedAt: publishing ? (publication.publishedAt ?? now) : publication.publishedAt,
        pricesLockedAt: publishing
          ? (publication.pricesLockedAt ?? now)
          : publication.pricesLockedAt,
        replayOnlineAt:
          command.to === PublicationState.REPLAY_ONLINE ? now : publication.replayOnlineAt,
      }),
      changed: new PublicationStateChanged(
        publication.dateId,
        publication.channelId,
        from,
        command.to,
        version + 1,
        transition.irreversiblePromiseCode !== null,
        now,
      ),
      engaged: publishing
        ? new PublicationEngaged(publication.dateId, publication.channelId, now)
        : null,
    };
  }
}
