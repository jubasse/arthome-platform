import {
  BlackoutReason as WireBlackoutReason,
  DateOutcome as WireDateOutcome,
  DateOutcomeDeclaredSchema,
  DateReplayPolicySetSchema,
  DateRescheduledSchema,
  DateRightsChangedSchema,
  DateScheduledSchema,
  PublicationState as WirePublicationState,
  PublicationStateChangedSchema,
  ReplayPolicy as WireReplayPolicy,
  RightsScope as WireRightsScope,
} from '@arthome-platform/events';
import { Outcome } from '@arthome-platform/messaging';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BlackoutReason,
  DateOutcome,
  DomainConstant,
  FixedClock,
  PublicationState,
  ReplayPolicy,
  RightsScope,
} from '@arthome/core';

import { readDateFacts, type DateFacts } from './entitlement-facts.js';
import {
  CATALOG_DATE_TOPIC,
  startProjection,
  wireMessage,
  type Projection,
  type WireMessage,
} from '../itest/entitlement.js';

/**
 * A date's facts, one row in groups each guarded by its own instant (R3, R10): the publication by
 *   catalog's version, the outcome by its `declared_at`, and what this build does not know kept
 *   out of what it would open (R7).
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const NOW = '2026-10-10T10:00:00.000Z';
const CHANNEL = '01a0f520-0000-7000-8000-0000000000c1';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const MOVED_TO = '2026-12-19T19:00:00.000Z';

let projection: Projection;

const dateOf = (n: number): string => `01a0f521-0000-7000-8000-${String(n).padStart(12, '0')}`;
const at = (hour: number): ReturnType<typeof timestampFromDate> =>
  timestampFromDate(new Date(Date.UTC(2026, 9, 1, hour)));

function scheduled(
  dateId: string,
  occurredAtHour: number,
  overrides: {
    readonly replayPolicy?: WireReplayPolicy;
    readonly rights?: MessageInitShape<typeof DateRightsChangedSchema>['rights'];
  } = {},
): WireMessage {
  return wireMessage(CATALOG_DATE_TOPIC, 'catalog.date.scheduled.v1', DateScheduledSchema, dateId, {
    dateId,
    channelId: CHANNEL,
    startsAt: timestampFromDate(new Date(STARTS_AT)),
    runtimeMin: 95,
    replayPolicy: WireReplayPolicy.INCLUDED,
    replayWindowHours: 48,
    rights: { scope: WireRightsScope.WORLDWIDE },
    occurredAt: at(occurredAtHour),
    ...overrides,
  });
}

function rescheduled(dateId: string, occurredAtHour: number): WireMessage {
  return wireMessage(
    CATALOG_DATE_TOPIC,
    'catalog.date.rescheduled.v1',
    DateRescheduledSchema,
    dateId,
    { dateId, newStartsAt: timestampFromDate(new Date(MOVED_TO)), occurredAt: at(occurredAtHour) },
  );
}

function replaySet(
  dateId: string,
  policy: WireReplayPolicy,
  windowHours: number,
  occurredAtHour: number,
): WireMessage {
  return wireMessage(
    CATALOG_DATE_TOPIC,
    'catalog.date.replay_policy_set.v1',
    DateReplayPolicySetSchema,
    dateId,
    { dateId, policy, windowHours, occurredAt: at(occurredAtHour) },
  );
}

function rightsChanged(
  dateId: string,
  rights: MessageInitShape<typeof DateRightsChangedSchema>['rights'],
  occurredAtHour: number,
): WireMessage {
  return wireMessage(
    CATALOG_DATE_TOPIC,
    'catalog.date.rights_changed.v1',
    DateRightsChangedSchema,
    dateId,
    { dateId, rights, occurredAt: at(occurredAtHour) },
  );
}

function publication(dateId: string, toState: WirePublicationState, version: bigint): WireMessage {
  return wireMessage(
    CATALOG_DATE_TOPIC,
    'catalog.publication.state_changed.v1',
    PublicationStateChangedSchema,
    dateId,
    { dateId, channelId: CHANNEL, toState, version, occurredAt: at(1) },
  );
}

function outcomeDeclared(
  dateId: string,
  outcome: WireDateOutcome,
  declaredAtHour: number,
): WireMessage {
  return wireMessage(
    CATALOG_DATE_TOPIC,
    'catalog.date.outcome_declared.v1',
    DateOutcomeDeclaredSchema,
    dateId,
    { dateId, channelId: CHANNEL, outcome, declaredAt: at(declaredAtHour) },
  );
}

async function factsOf(dateId: string): Promise<DateFacts | null> {
  return readDateFacts(projection.dataSource.manager, dateId);
}

async function outcomesOf(messages: readonly WireMessage[]): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const message of messages) outcomes.push(await projection.apply(message));
  return outcomes;
}

beforeAll(async () => {
  projection = await startProjection('streaming_entitlement_dates_itest', new FixedClock(NOW), {
    startupTimeoutMs: STARTUP_MS,
  });
}, STARTUP_MS);

afterAll(async () => {
  await projection?.close();
});

describe("a date's facts in the entitlement projection", () => {
  it(
    'reads a scheduled date with its timing, replay and rights, the room from the domain constant',
    async () => {
      const dateId = dateOf(1);
      expect(await projection.apply(scheduled(dateId, 10))).toBe(Outcome.APPLIED);

      expect(await factsOf(dateId)).toEqual({
        dateId,
        channelId: CHANNEL,
        timing: {
          startsAt: STARTS_AT,
          runtimeMin: 95,
          roomOpensBeforeMin: DomainConstant.ROOM_OPENS_MINUTES_BEFORE,
          replayPolicy: ReplayPolicy.INCLUDED,
          replayWindowHours: 48,
        },
        publicationState: null,
        outcome: null,
        rights: { scope: RightsScope.WORLDWIDE, blackoutCountries: [], reason: null },
      });
      expect(await factsOf(dateOf(999))).toBeNull();
    },
    CASE_MS,
  );

  it(
    'guards each group by its own instant: an older fact of one group leaves the others',
    async () => {
      const dateId = dateOf(2);
      const restricted = {
        scope: WireRightsScope.RESTRICTED,
        blackoutCountries: ['BE'],
        reason: WireBlackoutReason.FESTIVAL,
      };

      expect(
        await outcomesOf([
          replaySet(dateId, WireReplayPolicy.UNIT, 24, 12),
          rightsChanged(dateId, restricted, 12),
          scheduled(dateId, 10),
          replaySet(dateId, WireReplayPolicy.SUBSCRIPTION, 72, 11),
          rightsChanged(dateId, { scope: WireRightsScope.WORLDWIDE }, 11),
          rescheduled(dateId, 9),
        ]),
      ).toEqual([
        Outcome.APPLIED,
        Outcome.APPLIED,
        Outcome.APPLIED,
        Outcome.SUPERSEDED,
        Outcome.SUPERSEDED,
        Outcome.SUPERSEDED,
      ]);
      expect(await factsOf(dateId)).toMatchObject({
        timing: { startsAt: STARTS_AT, replayPolicy: ReplayPolicy.UNIT, replayWindowHours: 24 },
        rights: {
          scope: RightsScope.RESTRICTED,
          blackoutCountries: ['BE'],
          reason: BlackoutReason.FESTIVAL,
        },
      });

      expect(await outcomesOf([scheduled(dateId, 10), scheduled(dateId, 9)])).toEqual([
        Outcome.APPLIED,
        Outcome.SUPERSEDED,
      ]);
    },
    CASE_MS,
  );

  it(
    'guards the publication by version, never by its instant',
    async () => {
      const dateId = dateOf(3);

      expect(
        await outcomesOf([
          publication(dateId, WirePublicationState.SCHEDULED, 3n),
          publication(dateId, WirePublicationState.RESERVE, 2n),
          publication(dateId, WirePublicationState.DRAFT, 3n),
        ]),
      ).toEqual([Outcome.APPLIED, Outcome.SUPERSEDED, Outcome.SUPERSEDED]);
      expect(await factsOf(dateId)).toMatchObject({
        channelId: CHANNEL,
        publicationState: PublicationState.SCHEDULED,
        timing: null,
      });

      expect(await projection.apply(publication(dateId, WirePublicationState.LIVE, 4n))).toBe(
        Outcome.APPLIED,
      );
      expect((await factsOf(dateId))?.publicationState).toBe(PublicationState.LIVE);
    },
    CASE_MS,
  );

  it(
    'leaves the timing null after a reschedule overtaking its schedule, until both are applied',
    async () => {
      const dateId = dateOf(4);

      expect(await projection.apply(rescheduled(dateId, 12))).toBe(Outcome.APPLIED);
      expect((await factsOf(dateId))?.timing).toBeNull();

      expect(await projection.apply(scheduled(dateId, 10))).toBe(Outcome.APPLIED);
      expect((await factsOf(dateId))?.timing).toMatchObject({ startsAt: MOVED_TO, runtimeMin: 95 });

      expect(await projection.apply(scheduled(dateId, 9))).toBe(Outcome.SUPERSEDED);
    },
    CASE_MS,
  );

  it(
    'reads a date postponed then cancelled as cancelled, in either order of arrival',
    async () => {
      const inOrder = dateOf(5);
      const late = dateOf(6);

      expect(
        await outcomesOf([
          outcomeDeclared(inOrder, WireDateOutcome.POSTPONED, 10),
          outcomeDeclared(inOrder, WireDateOutcome.CANCELLED, 11),
          outcomeDeclared(late, WireDateOutcome.CANCELLED, 11),
          outcomeDeclared(late, WireDateOutcome.POSTPONED, 10),
        ]),
      ).toEqual([Outcome.APPLIED, Outcome.APPLIED, Outcome.APPLIED, Outcome.SUPERSEDED]);
      expect((await factsOf(inOrder))?.outcome).toBe(DateOutcome.CANCELLED);
      expect((await factsOf(late))?.outcome).toBe(DateOutcome.CANCELLED);
    },
    CASE_MS,
  );

  it(
    'fails closed on a member this build does not know',
    async () => {
      const dateId = dateOf(7);

      expect(
        await outcomesOf([
          scheduled(dateId, 10, {
            replayPolicy: 9 as WireReplayPolicy,
            rights: {
              scope: WireRightsScope.RESTRICTED,
              blackoutCountries: ['CH'],
              reason: 8 as WireBlackoutReason,
            },
          }),
          publication(dateId, 12 as WirePublicationState, 1n),
          outcomeDeclared(dateId, WireDateOutcome.CANCELLED, 10),
          outcomeDeclared(dateId, 7 as WireDateOutcome, 11),
        ]),
      ).toEqual([Outcome.APPLIED, Outcome.APPLIED, Outcome.APPLIED, Outcome.IGNORED]);
      expect(await factsOf(dateId)).toMatchObject({
        timing: { replayPolicy: ReplayPolicy.NONE },
        publicationState: null,
        outcome: DateOutcome.CANCELLED,
        rights: { scope: RightsScope.RESTRICTED, blackoutCountries: ['CH'], reason: null },
      });

      expect(
        await projection.apply(rightsChanged(dateId, { scope: 5 as WireRightsScope }, 11)),
      ).toBe(Outcome.APPLIED);
      expect((await factsOf(dateId))?.rights).toBeNull();
    },
    CASE_MS,
  );
});
