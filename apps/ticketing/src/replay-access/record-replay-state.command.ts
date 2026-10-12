import type { Outcome } from '@arthome-platform/messaging';
import { Command } from '@nestjs/cqrs';

import type { Instant, ReplayPolicy, ReplayState } from '@arthome/core';

/** What `catalog.replay.state_changed.v1` says of a date's `Replay` (RC1 §6.6). */
export interface ReplayStateFact {
  readonly kind: 'replay_state';
  readonly dateId: string;
  /** The `Replay`'s, strictly increasing with gaps: the newest kept wins. */
  readonly version: bigint;
  readonly toState: ReplayState;
  readonly policy: ReplayPolicy;
  readonly liveEndedAt: Instant;
  readonly closesAt: Instant;
  /** Set once the replay went online, kept on every later message. */
  readonly onlineAt: Instant | null;
}

/** Dispatched by the consumer, once per `catalog.replay.state_changed.v1` it reads. */
export class RecordReplayState extends Command<Outcome> {
  public constructor(
    public readonly messageId: string,
    public readonly topic: string,
    public readonly fact: ReplayStateFact,
  ) {
    super();
  }
}
