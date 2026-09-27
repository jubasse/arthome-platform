import { AggregateRoot } from '@nestjs/cqrs';

import {
  DomainConstant,
  assertOutcomeDeclarable,
  type DateOutcome,
  type Instant,
  type OutcomeDeclaration,
  type PublicationState,
  type ReplayPolicy,
  type TerritoryRights,
} from '@arthome/core';

import {
  DateOutcomeDeclared,
  DateRescheduled,
  type OutcomeMessage,
  type PerformanceDateEvent,
} from './performance-date.events.js';

export interface PerformanceDateSnapshot {
  readonly id: string;
  readonly showId: string;
  readonly venueId: string;
  readonly channelId: string;
  readonly startsAt: Instant;
  readonly runtimeMin: number;
  readonly replayPolicy: ReplayPolicy;
  readonly replayWindowHours: number | null;
  readonly rights: TerritoryRights;
  /** Its day at the venue, unique within its show; null until publication (D-075). */
  readonly slug: string | null;
  readonly postponements: number;
  readonly outcome: DateOutcome | null;
  readonly rescheduledTo: Instant | null;
  readonly outcomeDeclaredAt: Instant | null;
  readonly outcomeMessage: OutcomeMessage | null;
}

export interface OutcomeContext {
  readonly publicationState: PublicationState;
  /** The first slug free at a postponement's new start (`freeDateSlug`); null otherwise. */
  readonly slugAtNewStart: string | null;
  readonly now: Instant;
}

/**
 * data-model.md §2.2's `Date`. It has no version of its own: every command on it is conditioned
 *   on its publication's, which the studio's sheet serves.
 */
export class PerformanceDate extends AggregateRoot<PerformanceDateEvent> {
  private constructor(private current: PerformanceDateSnapshot) {
    super();
  }

  public static restore(snapshot: PerformanceDateSnapshot): PerformanceDate {
    return new PerformanceDate(snapshot);
  }

  public get snapshot(): PerformanceDateSnapshot {
    return this.current;
  }

  /**
   * An outcome, when core's rule allows it (D-076). A postponement moves the date and its slug in
   *   the same act (D-074, D-075), so `DateRescheduled` follows `DateOutcomeDeclared`.
   */
  public declareOutcome(
    declaration: OutcomeDeclaration,
    message: OutcomeMessage,
    { publicationState, slugAtNewStart, now }: OutcomeContext,
  ): void {
    const date = this.current;
    assertOutcomeDeclarable(
      {
        outcome: date.outcome,
        postponements: date.postponements,
        publicationState,
        timing: {
          startsAt: date.startsAt,
          runtimeMin: date.runtimeMin,
          roomOpensBeforeMin: DomainConstant.ROOM_OPENS_MINUTES_BEFORE,
          replayPolicy: date.replayPolicy,
          replayWindowHours: date.replayWindowHours ?? 0,
        },
      },
      declaration,
      now,
    );

    const movedTo = declaration.rescheduledTo;
    // A public date always holds a slug, set by its publication: the id only satisfies the type.
    const previousSlug = date.slug ?? date.id;
    let slug = previousSlug;
    if (movedTo !== null) {
      if (slugAtNewStart === null) throw new Error('a postponement without its new slug');
      slug = slugAtNewStart;
    }

    this.current = {
      ...date,
      outcome: declaration.outcome,
      rescheduledTo: movedTo,
      outcomeDeclaredAt: now,
      outcomeMessage: message,
      startsAt: movedTo ?? date.startsAt,
      slug,
      postponements: date.postponements + (movedTo === null ? 0 : 1),
    };
    this.apply(
      new DateOutcomeDeclared(date.id, date.channelId, declaration.outcome, message, movedTo, now),
    );
    if (movedTo !== null) {
      this.apply(
        new DateRescheduled(date.id, date.showId, date.startsAt, movedTo, previousSlug, slug, now),
      );
    }
  }
}
