// Aliased because `@arthome-platform/events` is a flat barrel: a wire enum and core's
// vocabulary share each name, and they are a number and a string.
import {
  BlackoutReason as WireBlackoutReason,
  DateOutcome as WireDateOutcome,
  PlanOpening as WirePlanOpening,
  PlanTier as WirePlanTier,
  PublicationState as WirePublicationState,
  ReplayPolicy as WireReplayPolicy,
  RightsScope as WireRightsScope,
  SubscriptionState as WireSubscriptionState,
} from '@arthome-platform/events';

import {
  BlackoutReason,
  DateOutcome,
  PlanOpening,
  PlanTier,
  PublicationState,
  ReplayPolicy,
  RightsScope,
  SubscriptionState,
} from '@arthome/core';

/**
 * The domain's members → the wire's numbers. `satisfies` points at the domain: a new member in core
 * fails this build, and the proto's `UNSPECIFIED = 0` rightly has no domain member. Read back, a
 * number this build does not know is kept out of what it would open (critical rule 10).
 */
const WIRE_PUBLICATION_STATE = {
  [PublicationState.DRAFT]: WirePublicationState.DRAFT,
  [PublicationState.RESERVE]: WirePublicationState.RESERVE,
  [PublicationState.SCHEDULED]: WirePublicationState.SCHEDULED,
  [PublicationState.TECHNICAL]: WirePublicationState.TECHNICAL,
  [PublicationState.LIVE]: WirePublicationState.LIVE,
  [PublicationState.ENDED]: WirePublicationState.ENDED,
  [PublicationState.REPLAY_ONLINE]: WirePublicationState.REPLAY_ONLINE,
} satisfies Record<PublicationState, WirePublicationState>;

const WIRE_DATE_OUTCOME = {
  [DateOutcome.POSTPONED]: WireDateOutcome.POSTPONED,
  [DateOutcome.CANCELLED]: WireDateOutcome.CANCELLED,
  [DateOutcome.INTERRUPTED]: WireDateOutcome.INTERRUPTED,
} satisfies Record<DateOutcome, WireDateOutcome>;

const WIRE_REPLAY_POLICY = {
  [ReplayPolicy.INCLUDED]: WireReplayPolicy.INCLUDED,
  [ReplayPolicy.SUBSCRIPTION]: WireReplayPolicy.SUBSCRIPTION,
  [ReplayPolicy.UNIT]: WireReplayPolicy.UNIT,
  [ReplayPolicy.NONE]: WireReplayPolicy.NONE,
} satisfies Record<ReplayPolicy, WireReplayPolicy>;

const WIRE_RIGHTS_SCOPE = {
  [RightsScope.WORLDWIDE]: WireRightsScope.WORLDWIDE,
  [RightsScope.RESTRICTED]: WireRightsScope.RESTRICTED,
} satisfies Record<RightsScope, WireRightsScope>;

const WIRE_BLACKOUT_REASON = {
  [BlackoutReason.CO_PRODUCTION]: WireBlackoutReason.CO_PRODUCTION,
  [BlackoutReason.BROADCASTER]: WireBlackoutReason.BROADCASTER,
  [BlackoutReason.FESTIVAL]: WireBlackoutReason.FESTIVAL,
} satisfies Record<BlackoutReason, WireBlackoutReason>;

const WIRE_PLAN_TIER = {
  [PlanTier.FREE]: WirePlanTier.FREE,
  [PlanTier.PASS]: WirePlanTier.PASS,
  [PlanTier.PREMIUM]: WirePlanTier.PREMIUM,
} satisfies Record<PlanTier, WirePlanTier>;

const WIRE_SUBSCRIPTION_STATE = {
  [SubscriptionState.ACTIVE]: WireSubscriptionState.ACTIVE,
  [SubscriptionState.PAST_DUE]: WireSubscriptionState.PAST_DUE,
  [SubscriptionState.CANCELLED]: WireSubscriptionState.CANCELLED,
  [SubscriptionState.TRIALING]: WireSubscriptionState.TRIALING,
} satisfies Record<SubscriptionState, WireSubscriptionState>;

const WIRE_PLAN_OPENING = {
  [PlanOpening.BROWSE]: WirePlanOpening.BROWSE,
  [PlanOpening.TRAILERS]: WirePlanOpening.TRAILERS,
  [PlanOpening.FREE_DATES]: WirePlanOpening.FREE_DATES,
  [PlanOpening.REPLAYS]: WirePlanOpening.REPLAYS,
  [PlanOpening.NO_ADS]: WirePlanOpening.NO_ADS,
  [PlanOpening.ONE_LIVE_MONTH]: WirePlanOpening.ONE_LIVE_MONTH,
  [PlanOpening.ALL_LIVES]: WirePlanOpening.ALL_LIVES,
  [PlanOpening.MULTI_SCREEN]: WirePlanOpening.MULTI_SCREEN,
  [PlanOpening.ARCHIVE]: WirePlanOpening.ARCHIVE,
} satisfies Record<PlanOpening, WirePlanOpening>;

function domainOf<Member extends string, Wire extends number>(
  table: Readonly<Record<Member, Wire>>,
  wire: Wire,
): Member | null {
  const members = Object.keys(table) as Member[];
  return members.find((member) => table[member] === wire) ?? null;
}

/** Null for `UNSPECIFIED` and for a member this build does not know: PS3 refuses. */
export function publicationStateOf(wire: WirePublicationState): PublicationState | null {
  return domainOf(WIRE_PUBLICATION_STATE, wire);
}

/** Null for a member this build does not know: the fact is ignored, as ticketing's consumer does. */
export function dateOutcomeOf(wire: WireDateOutcome): DateOutcome | null {
  return domainOf(WIRE_DATE_OUTCOME, wire);
}

/** An unknown policy opens no replay. */
export function replayPolicyOf(wire: WireReplayPolicy): ReplayPolicy {
  return domainOf(WIRE_REPLAY_POLICY, wire) ?? ReplayPolicy.NONE;
}

/** Null for an unknown scope, an absent `rights` included: PS3 refuses. */
export function rightsScopeOf(wire: WireRightsScope): RightsScope | null {
  return domainOf(WIRE_RIGHTS_SCOPE, wire);
}

/** Null for an unknown reason; the countries stay blacked out. */
export function blackoutReasonOf(wire: WireBlackoutReason): BlackoutReason | null {
  return domainOf(WIRE_BLACKOUT_REASON, wire);
}

export function planTierOf(wire: WirePlanTier): PlanTier | null {
  return domainOf(WIRE_PLAN_TIER, wire);
}

/** Null for an unknown state, which opens nothing. */
export function subscriptionStateOf(wire: WireSubscriptionState): SubscriptionState | null {
  return domainOf(WIRE_SUBSCRIPTION_STATE, wire);
}

/** An unknown opening is dropped. */
export function openingsOf(wire: readonly WirePlanOpening[]): PlanOpening[] {
  return wire.flatMap((opening) => domainOf(WIRE_PLAN_OPENING, opening) ?? []);
}
