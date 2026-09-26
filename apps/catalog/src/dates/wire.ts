import {
  PublicationState as WirePublicationState,
  ReplayPolicy as WireReplayPolicy,
} from '@arthome-platform/events';

import { PublicationState, ReplayPolicy } from '@arthome/core';

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
