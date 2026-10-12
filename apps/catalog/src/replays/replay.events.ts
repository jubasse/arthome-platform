import type { IEvent } from '@nestjs/cqrs';

import type { Instant, ReplayPolicy, ReplayState } from '@arthome/core';

import type { PerformanceDateEvent } from '../dates/performance-date.events.js';

/** Every published move of a `Replay`, the file's arrival excepted (adr-replay.md §5). */
export class ReplayStateChanged implements IEvent {
  public readonly kind = 'ReplayStateChanged';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    /** Null when the change creates the `Replay`. */
    public readonly from: ReplayState | null,
    public readonly to: ReplayState,
    public readonly version: number,
    public readonly policy: ReplayPolicy,
    public readonly liveEndedAt: Instant,
    public readonly closesAt: Instant,
    /** Set once the `Replay` went online, and kept after. */
    public readonly onlineAt: Instant | null,
    /** The file's, set once the `Replay` went online, and kept after. */
    public readonly durationSec: number | null,
    public readonly occurredAt: Instant,
  ) {}
}

export type ReplayEvent = ReplayStateChanged;

/**
 * Every event keyed by the date, its `Replay`'s included: a command moving both records them
 *   together, the date's first, so a partition reads `live -> ended` before `pending`.
 */
export type DateKeyedEvent = PerformanceDateEvent | ReplayEvent;
