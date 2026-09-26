// Aliased because `@arthome-platform/events` is a flat barrel: a wire enum and core's
// vocabulary share each name, and they are a number and a string.
import {
  BlackoutReason as WireBlackoutReason,
  LanguageDependency as WireLanguageDependency,
  PublicationState as WirePublicationState,
  ReplayPolicy as WireReplayPolicy,
  RightsScope as WireRightsScope,
} from '@arthome-platform/events';

import {
  BlackoutReason,
  LanguageDependency,
  PublicationState,
  ReplayPolicy,
  RightsScope,
} from '@arthome/core';

/**
 * The domain's members → the wire's numbers. `satisfies` points at the domain: a new member in
 * core fails this build, and the proto's `UNSPECIFIED = 0` rightly has no domain member.
 */
export const WIRE_PUBLICATION_STATE = {
  [PublicationState.DRAFT]: WirePublicationState.DRAFT,
  [PublicationState.RESERVE]: WirePublicationState.RESERVE,
  [PublicationState.SCHEDULED]: WirePublicationState.SCHEDULED,
  [PublicationState.TECHNICAL]: WirePublicationState.TECHNICAL,
  [PublicationState.LIVE]: WirePublicationState.LIVE,
  [PublicationState.ENDED]: WirePublicationState.ENDED,
  [PublicationState.REPLAY_ONLINE]: WirePublicationState.REPLAY_ONLINE,
} satisfies Record<PublicationState, WirePublicationState>;

export const WIRE_REPLAY_POLICY = {
  [ReplayPolicy.INCLUDED]: WireReplayPolicy.INCLUDED,
  [ReplayPolicy.SUBSCRIPTION]: WireReplayPolicy.SUBSCRIPTION,
  [ReplayPolicy.UNIT]: WireReplayPolicy.UNIT,
  [ReplayPolicy.NONE]: WireReplayPolicy.NONE,
} satisfies Record<ReplayPolicy, WireReplayPolicy>;

export const WIRE_RIGHTS_SCOPE = {
  [RightsScope.WORLDWIDE]: WireRightsScope.WORLDWIDE,
  [RightsScope.RESTRICTED]: WireRightsScope.RESTRICTED,
} satisfies Record<RightsScope, WireRightsScope>;

export const WIRE_BLACKOUT_REASON = {
  [BlackoutReason.CO_PRODUCTION]: WireBlackoutReason.CO_PRODUCTION,
  [BlackoutReason.BROADCASTER]: WireBlackoutReason.BROADCASTER,
  [BlackoutReason.FESTIVAL]: WireBlackoutReason.FESTIVAL,
} satisfies Record<BlackoutReason, WireBlackoutReason>;

/**
 * The domain's member → the wire's number.
 *
 * An encoding, not a parallel literal table (§5.2): there is one spelling — core's, which
 *   is also the wire's — plus a Protobuf number that cannot be avoided, only written once
 *   from the two generated sides. No string literal on either side.
 * `satisfies` points at the domain on purpose: a fourth member of `LANGUAGE_DEPENDENCIES`
 *   fails this build, because the domain leads. The reverse is deliberately not checked —
 *   the proto's `UNSPECIFIED = 0` has no domain member and must not acquire one.
 */
export const WIRE_LANGUAGE_DEPENDENCY = {
  [LanguageDependency.NONE]: WireLanguageDependency.NONE,
  [LanguageDependency.HELPFUL]: WireLanguageDependency.HELPFUL,
  [LanguageDependency.ESSENTIAL]: WireLanguageDependency.ESSENTIAL,
} satisfies Record<LanguageDependency, WireLanguageDependency>;
