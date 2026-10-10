import { frozen } from '@arthome-platform/transactions';
import { AggregateRoot } from '@nestjs/cqrs';

import {
  isPriorityWindowOpen,
  waitlistEntryMayMove,
  waitlistStateOnJoin,
  WaitlistEntryState,
  type Instant,
} from '@arthome/core';

import { WaitlistJoined, WaitlistLeft, type WaitlistEntryEvent } from './waitlist-entry.events.js';

export interface WaitlistEntrySnapshot {
  readonly id: string;
  readonly dateId: string;
  readonly accountId: string;
  readonly state: WaitlistEntryState;
  readonly joinedAt: Instant;
  /** When the account was told of the window it is in; what its conversion is measured from. */
  readonly notifiedAt: Instant | null;
  readonly endedAt: Instant | null;
  readonly version: number;
}

const ON_LIST: readonly WaitlistEntryState[] = [
  WaitlistEntryState.WAITING,
  WaitlistEntryState.NOTIFIED,
];

export function isOnWaitlist(state: WaitlistEntryState | null): boolean {
  return state !== null && ON_LIST.includes(state);
}

/**
 * One account's registration on one date's waiting list (adr-ticketing.md §9, D-083): no rank, one
 *   row per account, registered again on the same row. A tier opening, the window's end and the
 *   date's cancellation move entries set-based (HANDOVER §0p), each move core's
 *   `waitlistEntryMayMove` allows.
 */
export class WaitlistEntry extends AggregateRoot<WaitlistEntryEvent> {
  private current: WaitlistEntrySnapshot;

  private constructor(current: WaitlistEntrySnapshot) {
    super();
    this.current = frozen(current);
  }

  public static restore(snapshot: WaitlistEntrySnapshot): WaitlistEntry {
    return new WaitlistEntry(snapshot);
  }

  /** Notified at once into a window open at `now`. */
  public static join(
    registration: { readonly id: string; readonly dateId: string; readonly accountId: string },
    priorityUntil: Instant | null,
    now: Instant,
  ): WaitlistEntry {
    const windowOpen = isPriorityWindowOpen(priorityUntil, now);
    const entry = new WaitlistEntry({
      ...registration,
      state: waitlistStateOnJoin(windowOpen),
      joinedAt: now,
      notifiedAt: windowOpen ? now : null,
      endedAt: null,
      version: 1,
    });
    entry.applyJoined(priorityUntil, now);
    return entry;
  }

  public get snapshot(): WaitlistEntrySnapshot {
    return this.current;
  }

  public get isOnList(): boolean {
    return isOnWaitlist(this.current.state);
  }

  /** From `left`, `lapsed` or `converted`, as a new registration would be. */
  public rejoin(priorityUntil: Instant | null, now: Instant): void {
    const windowOpen = isPriorityWindowOpen(priorityUntil, now);
    this.moveTo(waitlistStateOnJoin(windowOpen));
    this.current = frozen({
      ...this.current,
      joinedAt: now,
      notifiedAt: windowOpen ? now : null,
      endedAt: null,
    });
    this.applyJoined(priorityUntil, now);
  }

  /** False, nothing moved, when the entry is not on the list; a notified one gives up its window. */
  public leave(now: Instant): boolean {
    if (!this.isOnList) return false;
    this.moveTo(WaitlistEntryState.LEFT);
    this.current = frozen({ ...this.current, endedAt: now });
    const { id, dateId, accountId } = this.current;
    this.apply(new WaitlistLeft(id, dateId, accountId, now));
    return true;
  }

  private applyJoined(priorityUntil: Instant | null, now: Instant): void {
    const { id, dateId, accountId, state } = this.current;
    const notified = state === WaitlistEntryState.NOTIFIED;
    this.apply(
      new WaitlistJoined(id, dateId, accountId, state, notified ? priorityUntil : null, now),
    );
  }

  private moveTo(state: WaitlistEntryState): void {
    const { id, state: from, version } = this.current;
    if (!waitlistEntryMayMove(from, state)) {
      throw new Error(`waitlist entry ${id} cannot move from ${from} to ${state}`);
    }
    this.current = frozen({ ...this.current, state, version: version + 1 });
  }
}
