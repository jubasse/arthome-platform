import {
  DateOutcome as WireDateOutcome,
  DateOutcomeDeclaredSchema,
  DateScheduledSchema,
  PlanOpening as WirePlanOpening,
  PlanTier as WirePlanTier,
  PublicationState as WirePublicationState,
  PublicationStateChangedSchema,
  ReplayPolicy as WireReplayPolicy,
  RightsScope as WireRightsScope,
  SeatActivatedSchema,
  SeatCancelledSchema,
  SubscriptionChangedSchema,
  SubscriptionState as WireSubscriptionState,
} from '@arthome-platform/events';
import { Outcome } from '@arthome-platform/messaging';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DomainConstant,
  FixedClock,
  PlanOpening,
  PublicationState,
  ReplayPolicy,
  RightsScope,
  WatchDenialReason,
  WatchScope,
  concurrentStreamsAllowedFor,
  decideWatch,
  type WatchVerdict,
} from '@arthome/core';

import { readDateFacts, readEntitlementFacts, type EntitlementFacts } from './entitlement-facts.js';
import {
  ACCOUNT_TOPIC,
  CATALOG_DATE_TOPIC,
  DATE_SALES_TOPIC,
  startProjection,
  wireMessage,
  type Projection,
  type WireMessage,
} from '../itest/entitlement.js';

/**
 * The read interface PS3 assembles into core's `WatchInput` (R5): on rows the consumer wrote, the
 *   facts in their shape, and `decideWatch` deciding from them alone.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const NOW = '2026-12-12T18:50:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const OCCURRED_AT = timestampFromDate(new Date('2026-10-01T10:00:00.000Z'));
const CHANNEL = '01a0f540-0000-7000-8000-0000000000c1';
const DATE = '01a0f541-0000-7000-8000-000000000001';
const CANCELLED_DATE = '01a0f541-0000-7000-8000-000000000002';
const HOLDER = '01a0f542-0000-7000-8000-000000000001';
const LOST = '01a0f542-0000-7000-8000-000000000002';
const SUBSCRIBER = '01a0f542-0000-7000-8000-000000000003';

let projection: Projection;

const seatOf = (n: number): string => `01a0f543-0000-7000-8000-${String(n).padStart(12, '0')}`;

function seatFact(
  schema: typeof SeatActivatedSchema | typeof SeatCancelledSchema,
  type: 'ticketing.seat.activated.v1' | 'ticketing.seat.cancelled.v1',
  n: number,
  accountId: string,
  dateId: string,
): WireMessage {
  return wireMessage(DATE_SALES_TOPIC, type, schema, dateId, {
    seatId: seatOf(n),
    accountId,
    dateId,
    occurredAt: OCCURRED_AT,
  });
}

function factsOf(accountId: string, dateId: string = DATE): Promise<EntitlementFacts> {
  return readEntitlementFacts(projection.dataSource.manager, { accountId, dateId, now: NOW });
}

/** What PS3 builds from the facts, the viewer's country resolved at the opening, never projected. */
function verdictOf(facts: EntitlementFacts): WatchVerdict {
  const date = facts.date;
  if (date?.timing == null || date.rights === null || date.publicationState === null) {
    throw new Error('a date PS3 refuses before deciding');
  }
  return decideWatch({
    holdsSeat: facts.activeSeatsOnDate > 0,
    seatExpired: facts.seatExpired,
    planOpenings: facts.planOpenings,
    concurrentStreamsOpen: 0,
    concurrentStreamsAllowed: concurrentStreamsAllowedFor(
      facts.planOpenings,
      facts.activeSeatsOnDate,
    ),
    previewSecondsLeft: 0,
    viewerCountry: 'FR',
    rights: date.rights,
    timing: date.timing,
    publicationState: date.publicationState,
    runState: null,
    outcome: date.outcome,
    seatStanding: null,
    now: NOW,
  });
}

beforeAll(async () => {
  projection = await startProjection('streaming_entitlement_facts_itest', new FixedClock(NOW), {
    startupTimeoutMs: STARTUP_MS,
  });
  const messages = [
    ...[DATE, CANCELLED_DATE].flatMap((dateId) => [
      wireMessage(CATALOG_DATE_TOPIC, 'catalog.date.scheduled.v1', DateScheduledSchema, dateId, {
        dateId,
        channelId: CHANNEL,
        startsAt: timestampFromDate(new Date(STARTS_AT)),
        runtimeMin: 90,
        replayPolicy: WireReplayPolicy.INCLUDED,
        replayWindowHours: 48,
        rights: { scope: WireRightsScope.WORLDWIDE },
        occurredAt: OCCURRED_AT,
      }),
      wireMessage(
        CATALOG_DATE_TOPIC,
        'catalog.publication.state_changed.v1',
        PublicationStateChangedSchema,
        dateId,
        {
          dateId,
          channelId: CHANNEL,
          toState: WirePublicationState.SCHEDULED,
          version: 3n,
          occurredAt: OCCURRED_AT,
        },
      ),
    ]),
    wireMessage(
      CATALOG_DATE_TOPIC,
      'catalog.date.outcome_declared.v1',
      DateOutcomeDeclaredSchema,
      CANCELLED_DATE,
      {
        dateId: CANCELLED_DATE,
        channelId: CHANNEL,
        outcome: WireDateOutcome.CANCELLED,
        declaredAt: OCCURRED_AT,
      },
    ),
    seatFact(SeatActivatedSchema, 'ticketing.seat.activated.v1', 1, HOLDER, DATE),
    seatFact(SeatActivatedSchema, 'ticketing.seat.activated.v1', 2, HOLDER, DATE),
    seatFact(SeatActivatedSchema, 'ticketing.seat.activated.v1', 3, HOLDER, CANCELLED_DATE),
    seatFact(SeatActivatedSchema, 'ticketing.seat.activated.v1', 4, LOST, DATE),
    seatFact(SeatCancelledSchema, 'ticketing.seat.cancelled.v1', 4, LOST, DATE),
    wireMessage(
      ACCOUNT_TOPIC,
      'ticketing.subscription.changed.v1',
      SubscriptionChangedSchema,
      SUBSCRIBER,
      {
        accountId: SUBSCRIBER,
        plan: WirePlanTier.PREMIUM,
        state: WireSubscriptionState.ACTIVE,
        opens: [WirePlanOpening.ALL_LIVES, WirePlanOpening.MULTI_SCREEN],
        occurredAt: OCCURRED_AT,
      },
    ),
  ];
  for (const message of messages) {
    if ((await projection.apply(message)) !== Outcome.APPLIED) throw new Error('not seeded');
  }
}, STARTUP_MS);

afterAll(async () => {
  await projection?.close();
});

describe('the entitlement facts PS3 decides from', () => {
  it(
    "reads the account's seats, its openings and the date in WatchInput's terms",
    async () => {
      expect(await factsOf(HOLDER)).toEqual({
        activeSeatsOnDate: 2,
        seatExpired: false,
        planOpenings: [],
        date: {
          dateId: DATE,
          channelId: CHANNEL,
          timing: {
            startsAt: STARTS_AT,
            runtimeMin: 90,
            roomOpensBeforeMin: DomainConstant.ROOM_OPENS_MINUTES_BEFORE,
            replayPolicy: ReplayPolicy.INCLUDED,
            replayWindowHours: 48,
          },
          publicationState: PublicationState.SCHEDULED,
          outcome: null,
          rights: { scope: RightsScope.WORLDWIDE, blackoutCountries: [], reason: null },
        },
      });
      expect((await factsOf(SUBSCRIBER)).planOpenings).toEqual([
        PlanOpening.ALL_LIVES,
        PlanOpening.MULTI_SCREEN,
      ]);
      expect(await readDateFacts(projection.dataSource.manager, DATE)).toEqual(
        (await factsOf(HOLDER)).date,
      );
    },
    CASE_MS,
  );

  it(
    'answers the date null when the projection holds none of its facts',
    async () => {
      expect(await factsOf(HOLDER, '01a0f541-0000-7000-8000-000000000999')).toEqual({
        activeSeatsOnDate: 0,
        seatExpired: false,
        planOpenings: [],
        date: null,
      });
    },
    CASE_MS,
  );

  it(
    'lets decideWatch open the room to a seat holder and a subscriber, and refuse the others',
    async () => {
      const holder = verdictOf(await factsOf(HOLDER));
      expect(holder).toMatchObject({ allowed: true, scope: WatchScope.FULL });

      const subscriber = verdictOf(await factsOf(SUBSCRIBER));
      expect(subscriber).toMatchObject({ allowed: true, scope: WatchScope.FULL });

      expect(verdictOf(await factsOf(LOST))).toMatchObject({
        allowed: false,
        reason: WatchDenialReason.SEAT_EXPIRED,
      });
      expect(verdictOf(await factsOf(HOLDER, CANCELLED_DATE))).toMatchObject({
        allowed: false,
        reason: WatchDenialReason.DATE_CANCELLED,
      });
      expect(
        concurrentStreamsAllowedFor(
          (await factsOf(HOLDER)).planOpenings,
          (await factsOf(HOLDER)).activeSeatsOnDate,
        ),
      ).toBe(2);
    },
    CASE_MS,
  );
});
