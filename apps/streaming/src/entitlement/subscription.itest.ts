import {
  PlanOpening as WirePlanOpening,
  PlanTier as WirePlanTier,
  SubscriptionChangedSchema,
  SubscriptionState as WireSubscriptionState,
} from '@arthome-platform/events';
import { Outcome } from '@arthome-platform/messaging';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, PlanOpening, type Instant } from '@arthome/core';

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
 *   cancelled until the end of the last paid period, none after; an older fact superseded.
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
    },
  );
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
});
