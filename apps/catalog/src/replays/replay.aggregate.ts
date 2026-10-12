import { frozen } from '@arthome-platform/transactions';
import { AggregateRoot } from '@nestjs/cqrs';

import {
  ReplayState,
  assertReplayGoesOnline,
  replayClosesAt,
  type Instant,
  type ReplayPolicy,
} from '@arthome/core';

import { ReplayStateChanged, type ReplayEvent } from './replay.events.js';

export interface ReplaySnapshot {
  readonly dateId: string;
  readonly channelId: string;
  readonly state: ReplayState;
  /** The date's promise when its live ended. */
  readonly policy: ReplayPolicy;
  /** The run's real end, as streaming reported it. */
  readonly liveEndedAt: Instant;
  /** The one closing (D-113), computed once at the opening. */
  readonly closesAt: Instant;
  readonly assetDurationSec: number | null;
  /** The file's `available_from`, as streaming reported it. */
  readonly assetReadyAt: Instant | null;
  readonly onlineAt: Instant | null;
  readonly closedAt: Instant | null;
  readonly withdrawnAt: Instant | null;
  readonly version: number;
}

export interface ReplayOpening {
  readonly dateId: string;
  readonly channelId: string;
  readonly policy: ReplayPolicy;
  readonly liveEndedAt: Instant;
  readonly windowHours: number;
}

export interface ReplayAsset {
  readonly durationSec: number;
  readonly availableFrom: Instant;
}

const STILL_OPEN: ReadonlySet<ReplayState> = new Set([ReplayState.PENDING, ReplayState.ONLINE]);

/**
 * data-model.md §2.2's `Replay`, an aggregate of its own keyed by its date (adr-replay.md §5): it
 *   carries the online window, which the card, the accesses and the index read and never derive.
 */
export class Replay extends AggregateRoot<ReplayEvent> {
  /** Replaced, never edited, and frozen to hold it. */
  private current: ReplaySnapshot;

  private constructor(current: ReplaySnapshot) {
    super();
    this.current = frozen(current);
  }

  public static restore(snapshot: ReplaySnapshot): Replay {
    return new Replay(snapshot);
  }

  /** The live ended on a date that promised a replay: `pending` until the studio puts it online. */
  public static open(opening: ReplayOpening, now: Instant): Replay {
    const replay = new Replay({
      dateId: opening.dateId,
      channelId: opening.channelId,
      state: ReplayState.PENDING,
      policy: opening.policy,
      liveEndedAt: opening.liveEndedAt,
      closesAt: replayClosesAt(opening.liveEndedAt, opening.windowHours),
      assetDurationSec: null,
      assetReadyAt: null,
      onlineAt: null,
      closedAt: null,
      withdrawnAt: null,
      version: 1,
    });
    replay.apply(replay.stateChanged(null, now));
    return replay;
  }

  public get snapshot(): ReplaySnapshot {
    return this.current;
  }

  /** Whether it moved: the first file counts one version and publishes nothing; a second is ignored. */
  public learnAssetReady({ durationSec, availableFrom }: ReplayAsset): boolean {
    const replay = this.current;
    if (!STILL_OPEN.has(replay.state) || replay.assetReadyAt !== null) return false;
    this.current = frozen({
      ...replay,
      assetDurationSec: durationSec,
      assetReadyAt: availableFrom,
      version: replay.version + 1,
    });
    return true;
  }

  /** The studio's `ended -> replay_online`, refused by core unless `pending`, open and its file ready. */
  public goOnline(now: Instant): void {
    const replay = this.current;
    assertReplayGoesOnline({
      state: replay.state,
      assetReady: replay.assetReadyAt !== null,
      closing: { closesAt: replay.closesAt, now },
    });
    this.moveTo(ReplayState.ONLINE, { onlineAt: now }, now);
  }

  /** Whether it moved: a `Replay` already closed or withdrawn stays as it is. */
  public close(now: Instant): boolean {
    if (!STILL_OPEN.has(this.current.state)) return false;
    this.moveTo(ReplayState.CLOSED, { closedAt: now }, now);
    return true;
  }

  /** Whether it moved: a `Replay` already closed or withdrawn stays as it is. */
  public withdraw(now: Instant): boolean {
    if (!STILL_OPEN.has(this.current.state)) return false;
    this.moveTo(ReplayState.WITHDRAWN, { withdrawnAt: now }, now);
    return true;
  }

  private moveTo(
    to: ReplayState,
    stamp: Pick<Partial<ReplaySnapshot>, 'onlineAt' | 'closedAt' | 'withdrawnAt'>,
    now: Instant,
  ): void {
    const from = this.current.state;
    this.current = frozen({
      ...this.current,
      ...stamp,
      state: to,
      version: this.current.version + 1,
    });
    this.apply(this.stateChanged(from, now));
  }

  private stateChanged(from: ReplayState | null, now: Instant): ReplayStateChanged {
    const replay = this.current;
    const wentOnline = replay.onlineAt !== null;
    return new ReplayStateChanged(
      replay.dateId,
      replay.channelId,
      from,
      replay.state,
      replay.version,
      replay.policy,
      replay.liveEndedAt,
      replay.closesAt,
      replay.onlineAt,
      wentOnline ? replay.assetDurationSec : null,
      now,
    );
  }
}
