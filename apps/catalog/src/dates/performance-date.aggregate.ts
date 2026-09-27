import { frozen } from '@arthome-platform/transactions';
import { AggregateRoot } from '@nestjs/cqrs';

import {
  DomainConstant,
  DomainError,
  DomainErrorCode,
  assertOutcomeDeclarable,
  type DateOutcome,
  type Instant,
  type OutcomeDeclaration,
  type PublicationChecklistItem,
  type PublicationTransitionCommand,
  type ReplayPolicy,
  type TerritoryRights,
  worldwideRights,
} from '@arthome/core';

import {
  DateDrafted,
  DateOutcomeDeclared,
  DateRescheduled,
  DateScheduled,
  type OutcomeMessage,
  type PerformanceDateEvent,
  type PublicDateFacts,
} from './performance-date.events.js';
import { Publication, type PublicationSnapshot } from './publication.js';

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

/** A date its publication made public: it holds a slug from then on. */
export type PublicDateSnapshot = PerformanceDateSnapshot & { readonly slug: string };

export function publicFactsOf(date: PublicDateSnapshot): PublicDateFacts {
  return {
    dateId: date.id,
    channelId: date.channelId,
    showId: date.showId,
    venueId: date.venueId,
    startsAt: date.startsAt,
    runtimeMin: date.runtimeMin,
    replayPolicy: date.replayPolicy,
    replayWindowHours: date.replayWindowHours,
    rights: date.rights,
    slug: date.slug,
  };
}

function assertPublic(date: PerformanceDateSnapshot): asserts date is PublicDateSnapshot {
  if (date.slug === null) throw new Error(`date ${date.id} is public without a slug`);
}

/** What a draft is created with; the rest waits for its publication or an outcome. */
export type DateDraft = Pick<
  PerformanceDateSnapshot,
  | 'id'
  | 'showId'
  | 'venueId'
  | 'channelId'
  | 'startsAt'
  | 'runtimeMin'
  | 'replayPolicy'
  | 'replayWindowHours'
>;

export interface PublicationContext {
  /** Every checklist item satisfied now: publishing needs each blocking one (§2.3). */
  readonly satisfied: readonly PublicationChecklistItem[];
  /** The first slug free on its day (`freeDateSlug`) while the date has none: publishing takes it. */
  readonly freeSlug: string | null;
  /** Its show's running time now, which publishing freezes on the date (§2.2). */
  readonly showRuntimeMin: number;
  readonly now: Instant;
}

export interface OutcomeContext {
  /** The first slug free at a postponement's new start (`freeDateSlug`); null otherwise. */
  readonly slugAtNewStart: string | null;
  readonly now: Instant;
}

/**
 * data-model.md §2.2's `Date`, owning its `Publication` (D-085): two rows, one aggregate, one
 *   version, the publication's, which the studio's sheet serves and every command names.
 */
export class PerformanceDate extends AggregateRoot<PerformanceDateEvent> {
  /**
   * Replaced, never edited, and frozen to hold it: the repository skips the date row's UPDATE when
   *   this reference has not changed since the load, so a write in place would be lost in silence.
   */
  private current: PerformanceDateSnapshot;

  private constructor(
    current: PerformanceDateSnapshot,
    private currentPublication: Publication,
  ) {
    super();
    this.current = frozen(current);
  }

  public static restore(
    snapshot: PerformanceDateSnapshot,
    publication: PublicationSnapshot,
  ): PerformanceDate {
    return new PerformanceDate(snapshot, Publication.restore(publication));
  }

  /** Worldwide until its rights are restricted, and without a slug until its publication. */
  public static draft(draft: DateDraft, now: Instant): PerformanceDate {
    const date = new PerformanceDate(
      {
        ...draft,
        rights: worldwideRights(),
        slug: null,
        postponements: 0,
        outcome: null,
        rescheduledTo: null,
        outcomeDeclaredAt: null,
        outcomeMessage: null,
      },
      Publication.draft(draft.id, draft.channelId),
    );
    date.apply(new DateDrafted(draft.id, draft.channelId, draft.showId, draft.venueId, now));
    return date;
  }

  public get snapshot(): PerformanceDateSnapshot {
    return this.current;
  }

  public get publication(): PublicationSnapshot {
    return this.currentPublication.snapshot;
  }

  /**
   * A commanded transition of its publication. Publishing makes the date public in the same act,
   *   `DateScheduled` between the state change and what it engaged: no consumer may read the lock
   *   before the date's public facts.
   */
  public transitionPublication(
    command: PublicationTransitionCommand,
    context: PublicationContext,
  ): void {
    const { publication, changed, engaged } = this.currentPublication.transitioned(
      command,
      context.satisfied,
      context.now,
    );
    if (engaged === null) {
      this.currentPublication = publication;
      this.apply(changed);
      return;
    }
    const date = this.madePublic(context);
    this.currentPublication = publication;
    this.current = frozen(date);
    this.apply(changed);
    this.apply(new DateScheduled(publicFactsOf(date), context.now));
    this.apply(engaged);
  }

  /**
   * An outcome, when core's rule allows it (D-076), from the version the screen read. A
   *   postponement moves the date and its slug in the same act (D-074, D-075), so
   *   `DateRescheduled` follows `DateOutcomeDeclared`.
   */
  public declareOutcome(
    expectedVersion: number,
    declaration: OutcomeDeclaration,
    message: OutcomeMessage,
    { slugAtNewStart, now }: OutcomeContext,
  ): void {
    const publication = this.currentPublication.advancedFrom(expectedVersion);
    const date = this.current;
    assertOutcomeDeclarable(
      {
        outcome: date.outcome,
        postponements: date.postponements,
        publicationState: publication.snapshot.state,
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

    // Core refused any date its publication has not made public, and publishing set its slug.
    assertPublic(date);
    const movedTo = declaration.rescheduledTo;
    const previousSlug = date.slug;
    let slug = previousSlug;
    if (movedTo !== null) {
      if (slugAtNewStart === null) throw new Error('a postponement without its new slug');
      slug = slugAtNewStart;
    }

    this.currentPublication = publication;
    this.current = frozen({
      ...date,
      outcome: declaration.outcome,
      rescheduledTo: movedTo,
      outcomeDeclaredAt: now,
      outcomeMessage: structuredClone(message),
      startsAt: movedTo ?? date.startsAt,
      slug,
      postponements: date.postponements + (movedTo === null ? 0 : 1),
    });
    this.apply(
      new DateOutcomeDeclared(date.id, date.channelId, declaration.outcome, message, movedTo, now),
    );
    if (movedTo !== null) {
      this.apply(
        new DateRescheduled(date.id, date.showId, date.startsAt, movedTo, previousSlug, slug, now),
      );
    }
  }

  /** Publishing happens once: a date that already holds a slug is refused, naming it. */
  private madePublic({ freeSlug, showRuntimeMin }: PublicationContext): PublicDateSnapshot {
    const { slug } = this.current;
    if (slug !== null) {
      throw new DomainError({ code: DomainErrorCode.STATE_CONFLICT, params: { slug } });
    }
    if (freeSlug === null) throw new Error('publishing a date without its free slug');
    return { ...this.current, slug: freeSlug, runtimeMin: showRuntimeMin };
  }
}
