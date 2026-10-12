import {
  PlanOpening as WirePlanOpening,
  PlanTier as WirePlanTier,
  SubscriptionChangedSchema,
  SubscriptionState as WireSubscriptionState,
} from '@arthome-platform/events';
import { Outcome } from '@arthome-platform/messaging';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, PlanOpening, SubscriptionState, type Instant } from '@arthome/core';

import { readEntitlementFacts } from './entitlement-facts.js';
import {
  ACCOUNT_TOPIC,
  startProjection,
  wireMessage,
  type Projection,
  type WireMessage,
} from '../itest/entitlement.js';

/**
 * The subscription's openings in effect (D-125, R6): while active, trialing or past due; while
 *   cancelled until the end of the last paid period, none after; an older fact superseded, by
 *   ticketing's version when both facts carry one, else by `occurred_at` (SD1).
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const NOW = '2026-10-10T10:00:00.000Z';
const PAID_THROUGH = '2026-10-20T10:00:00.000Z';
const DATE = '01a0f530-0000-7000-8000-000000000001';

let projection: Projection;

const accountOf = (n: number): string => `01a0f531-0000-7000-8000-${String(n).padStart(12, '0')}`;

function changed(
  accountId: string,
  state: WireSubscriptionState,
  occurredAt: Instant,
  paidThrough: Instant | null = PAID_THROUGH,
  version = 0n,
): WireMessage {
  return wireMessage(
    ACCOUNT_TOPIC,
    'ticketing.subscription.changed.v1',
    SubscriptionChangedSchema,
    accountId,
    {
      accountId,
      plan: WirePlanTier.PREMIUM,
      state,
      opens: [WirePlanOpening.ALL_LIVES, WirePlanOpening.MULTI_SCREEN],
      concurrentStreamsAllowed: 2,
      currentPeriodEnd: timestampFromDate(new Date('2026-11-20T10:00:00.000Z')),
      ...(paidThrough === null ? {} : { paidThrough: timestampFromDate(new Date(paidThrough)) }),
      occurredAt: timestampFromDate(new Date(occurredAt)),
      version,
    },
  );
}

const versioned = (
  accountId: string,
  state: WireSubscriptionState,
  occurredAt: Instant,
  version: bigint,
): WireMessage => changed(accountId, state, occurredAt, PAID_THROUGH, version);

interface Kept {
  readonly state: string;
  readonly version: string | null;
  readonly occurredAt: string;
}

async function keptOf(accountId: string): Promise<Kept> {
  const [row] = await projection.dataSource.query<Kept[]>(
    `SELECT state, version, occurred_at AS "occurredAt"
       FROM entitlement_subscription WHERE account_id = $1`,
    [accountId],
  );
  if (row === undefined) throw new Error(`no subscription kept for ${accountId}`);
  return { ...row, occurredAt: new Date(row.occurredAt).toISOString() };
}

async function openingsAt(accountId: string, now: Instant): Promise<readonly PlanOpening[]> {
  const facts = await readEntitlementFacts(projection.dataSource.manager, {
    accountId,
    dateId: DATE,
    now,
  });
  return facts.planOpenings;
}

beforeAll(async () => {
  projection = await startProjection(
    'streaming_entitlement_subscription_itest',
    new FixedClock(NOW),
    { startupTimeoutMs: STARTUP_MS },
  );
}, STARTUP_MS);

afterAll(async () => {
  await projection?.close();
});

describe('the subscription in the entitlement projection', () => {
  const opened = [PlanOpening.ALL_LIVES, PlanOpening.MULTI_SCREEN];

  it(
    'opens its openings while active, trialing or past due, the payment being retried',
    async () => {
      const states = [
        WireSubscriptionState.ACTIVE,
        WireSubscriptionState.TRIALING,
        WireSubscriptionState.PAST_DUE,
      ];
      for (const [n, state] of states.entries()) {
        const account = accountOf(n + 1);
        expect(await projection.apply(changed(account, state, NOW, null))).toBe(Outcome.APPLIED);
        expect(await openingsAt(account, NOW)).toEqual(opened);
      }
    },
    CASE_MS,
  );

  it(
    'opens a cancelled subscription until the end of its paid period, nothing after',
    async () => {
      const account = accountOf(10);
      await projection.apply(changed(account, WireSubscriptionState.CANCELLED, NOW));

      expect(await openingsAt(account, NOW)).toEqual(opened);
      expect(await openingsAt(account, PAID_THROUGH)).toEqual([]);

      const neverPaid = accountOf(11);
      await projection.apply(changed(neverPaid, WireSubscriptionState.CANCELLED, NOW, null));
      expect(await openingsAt(neverPaid, NOW)).toEqual([]);
    },
    CASE_MS,
  );

  it(
    'opens nothing without a subscription, or in a state this build does not know',
    async () => {
      expect(await openingsAt(accountOf(20), NOW)).toEqual([]);

      const account = accountOf(21);
      await projection.apply(changed(account, 9 as WireSubscriptionState, NOW));
      expect(await openingsAt(account, NOW)).toEqual([]);
    },
    CASE_MS,
  );

  it(
    'keeps the newer fact: a final failure stays cancelled when an older active arrives late',
    async () => {
      const account = accountOf(30);

      expect(
        await projection.apply(
          changed(account, WireSubscriptionState.CANCELLED, '2026-10-09T10:00:00.000Z', NOW),
        ),
      ).toBe(Outcome.APPLIED);
      expect(
        await projection.apply(
          changed(account, WireSubscriptionState.ACTIVE, '2026-10-08T10:00:00.000Z'),
        ),
      ).toBe(Outcome.SUPERSEDED);
      expect(await openingsAt(account, NOW)).toEqual([]);
    },
    CASE_MS,
  );

  describe("ordered by ticketing's version when both facts carry one, else by occurred_at", () => {
    const EARLY = '2026-10-08T10:00:00.000Z';
    const MID = '2026-10-09T10:00:00.000Z';
    const LATE = NOW;
    const { ACTIVE, CANCELLED, PAST_DUE } = WireSubscriptionState;

    it(
      'applies a higher version over a lower one',
      async () => {
        const account = accountOf(40);
        expect(await projection.apply(versioned(account, ACTIVE, EARLY, 1n))).toBe(Outcome.APPLIED);
        expect(await projection.apply(versioned(account, CANCELLED, MID, 2n))).toBe(
          Outcome.APPLIED,
        );

        expect(await keptOf(account)).toEqual({
          state: SubscriptionState.CANCELLED,
          version: '2',
          occurredAt: MID,
        });
      },
      CASE_MS,
    );

    it(
      'supersedes a lower version and an equal one, the redelivery of a fact applied',
      async () => {
        const account = accountOf(41);
        await projection.apply(versioned(account, CANCELLED, EARLY, 2n));

        expect(await projection.apply(versioned(account, ACTIVE, MID, 1n))).toBe(
          Outcome.SUPERSEDED,
        );
        expect(await projection.apply(versioned(account, ACTIVE, LATE, 2n))).toBe(
          Outcome.SUPERSEDED,
        );
        expect(await keptOf(account)).toEqual({
          state: SubscriptionState.CANCELLED,
          version: '2',
          occurredAt: EARLY,
        });
      },
      CASE_MS,
    );

    it(
      'applies a higher version stated earlier: the version decides, not the instant',
      async () => {
        const account = accountOf(42);
        await projection.apply(versioned(account, ACTIVE, MID, 1n));

        expect(await projection.apply(versioned(account, CANCELLED, EARLY, 2n))).toBe(
          Outcome.APPLIED,
        );
        expect(await keptOf(account)).toEqual({
          state: SubscriptionState.CANCELLED,
          version: '2',
          occurredAt: MID,
        });
      },
      CASE_MS,
    );

    it(
      'orders two unversioned facts by occurred_at, as before',
      async () => {
        const account = accountOf(43);
        await projection.apply(changed(account, ACTIVE, EARLY));

        expect(await projection.apply(changed(account, CANCELLED, MID))).toBe(Outcome.APPLIED);
        expect(await projection.apply(changed(account, ACTIVE, EARLY))).toBe(Outcome.SUPERSEDED);
        expect(await keptOf(account)).toEqual({
          state: SubscriptionState.CANCELLED,
          version: null,
          occurredAt: MID,
        });
      },
      CASE_MS,
    );

    it(
      'decides a versioned fact over an unversioned row by occurred_at, and stores its version',
      async () => {
        const account = accountOf(44);
        await projection.apply(changed(account, ACTIVE, MID));

        expect(await projection.apply(versioned(account, CANCELLED, EARLY, 3n))).toBe(
          Outcome.SUPERSEDED,
        );
        expect(await keptOf(account)).toEqual({
          state: SubscriptionState.ACTIVE,
          version: null,
          occurredAt: MID,
        });

        expect(await projection.apply(versioned(account, CANCELLED, LATE, 3n))).toBe(
          Outcome.APPLIED,
        );
        expect(await keptOf(account)).toEqual({
          state: SubscriptionState.CANCELLED,
          version: '3',
          occurredAt: LATE,
        });
      },
      CASE_MS,
    );

    it(
      'decides an unversioned fact over a versioned row by occurred_at, the version kept',
      async () => {
        const account = accountOf(45);
        await projection.apply(versioned(account, ACTIVE, MID, 4n));

        expect(await projection.apply(changed(account, CANCELLED, EARLY))).toBe(Outcome.SUPERSEDED);
        expect(await projection.apply(changed(account, PAST_DUE, LATE))).toBe(Outcome.APPLIED);
        expect(await keptOf(account)).toEqual({
          state: SubscriptionState.PAST_DUE,
          version: '4',
          occurredAt: LATE,
        });
      },
      CASE_MS,
    );

    it(
      'keeps the latest instant seen, so an unversioned fact older than it is superseded',
      async () => {
        const account = accountOf(46);
        await projection.apply(versioned(account, ACTIVE, LATE, 1n));
        expect(await projection.apply(versioned(account, CANCELLED, EARLY, 2n))).toBe(
          Outcome.APPLIED,
        );

        expect(await projection.apply(changed(account, ACTIVE, MID))).toBe(Outcome.SUPERSEDED);
        expect(await keptOf(account)).toEqual({
          state: SubscriptionState.CANCELLED,
          version: '2',
          occurredAt: LATE,
        });
      },
      CASE_MS,
    );
  });
});
