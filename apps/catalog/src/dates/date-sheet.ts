import {
  nextPublicationTransitions,
  orderRankOf,
  publicationReadiness,
  type PublicationChecklistItem,
  type PublicationPromise,
  type PublicationState,
  type ReplayPolicy,
  type Service,
  type TerritoryRights,
  type VenueClock,
} from '@arthome/core';

import { ownChecklistFacts } from './own-checklist.js';
import type { PerformanceDateSnapshot } from './performance-date.aggregate.js';
import type { PublicationChecklistFact } from './publication-checklist-fact.entity.js';
import type { PublicationSnapshot } from './publication.aggregate.js';
import type { Show } from '../catalog/show.entity.js';
import { dateUrl } from '../public/links.js';
import { venueClockAt } from '../venues/venue-clock.js';
import type { Venue } from '../venues/venue.entity.js';

export interface ChecklistLine {
  readonly id: PublicationChecklistItem;
  readonly satisfied: boolean;
  readonly source: Service;
  readonly blocking: boolean;
}

export interface OfferedTransition {
  readonly from: PublicationState;
  readonly to: PublicationState;
  readonly irreversible: boolean;
  readonly promiseCode: PublicationPromise | null;
}

/** The shape of `openapi/studio.yaml`'s `Publication`, as far as this service holds it. */
export interface PublicationView {
  readonly dateId: string;
  readonly state: PublicationState;
  readonly orderRank: number;
  readonly version: number;
  readonly publishedAt: string | null;
  readonly pricesLockedAt: string | null;
  readonly replayOnlineAt: string | null;
  readonly checklist: readonly ChecklistLine[];
  readonly offeredTransitions: readonly OfferedTransition[];
}

export interface DateSheet {
  readonly dateId: string;
  readonly channelId: string;
  readonly showId: string;
  readonly venueId: string;
  readonly startsAt: string;
  readonly venueClock: VenueClock;
  readonly runtimeMin: number;
  readonly replayPolicy: ReplayPolicy;
  readonly replayWindowHours: number | null;
  readonly rights: TerritoryRights;
  /** Null until publication sets the slugs. */
  readonly canonicalUrl: string | null;
  readonly publication: PublicationView;
}

export interface DateRecords {
  readonly date: PerformanceDateSnapshot;
  readonly publication: PublicationSnapshot;
  readonly show: Show;
  readonly venue: Venue;
  readonly projectedFacts: readonly PublicationChecklistFact[];
}

/** Every item satisfied now: catalog's own read off the show, the rest as last reported. */
export function satisfiedChecklistItems(
  show: Show,
  projectedFacts: readonly PublicationChecklistFact[],
): PublicationChecklistItem[] {
  return [
    ...ownChecklistFacts(show),
    ...projectedFacts.filter((fact) => fact.satisfied).map((fact) => fact.item),
  ];
}

/**
 * `canDecide` is true for every caller while tokens are not verified: the routes are refused in
 * production by `DenyInProductionGuard`, so no real operator reaches this without rights.
 */
export function publicationView(
  publication: PublicationSnapshot,
  satisfied: readonly PublicationChecklistItem[],
): PublicationView {
  const readiness = publicationReadiness(satisfied);
  return {
    dateId: publication.dateId,
    state: publication.state,
    orderRank: orderRankOf(publication.state),
    version: publication.version,
    publishedAt: publication.publishedAt,
    pricesLockedAt: publication.pricesLockedAt,
    replayOnlineAt: publication.replayOnlineAt,
    checklist: readiness.entries.map((entry) => ({
      id: entry.item,
      satisfied: entry.satisfied,
      source: entry.source,
      blocking: entry.blocking,
    })),
    offeredTransitions: nextPublicationTransitions(publication.state, true).map((transition) => ({
      from: transition.from,
      to: transition.to,
      irreversible: transition.irreversiblePromiseCode !== null,
      promiseCode: transition.irreversiblePromiseCode,
    })),
  };
}

export function dateSheet(records: DateRecords, origin: string): DateSheet {
  const { date, publication, show, venue, projectedFacts } = records;
  return {
    dateId: date.id,
    channelId: date.channelId,
    showId: date.showId,
    venueId: date.venueId,
    startsAt: date.startsAt,
    venueClock: venueClockAt(venue.time_zone, date.startsAt),
    runtimeMin: date.runtimeMin,
    replayPolicy: date.replayPolicy,
    replayWindowHours: date.replayWindowHours,
    rights: date.rights,
    canonicalUrl: date.slug === null ? null : dateUrl(origin, show.slug, date.slug),
    publication: publicationView(publication, satisfiedChecklistItems(show, projectedFacts)),
  };
}
