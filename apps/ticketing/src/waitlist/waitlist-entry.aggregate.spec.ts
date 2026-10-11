import { describe, expect, it } from 'vitest';

import { WaitlistEntryState } from '@arthome/core';

import { WaitlistEntry, type WaitlistEntrySnapshot } from './waitlist-entry.aggregate.js';
import { WaitlistJoined, WaitlistLeft } from './waitlist-entry.events.js';

const ENTRY_ID = '01a0f000-0000-7000-8000-000000000001';
const DATE_ID = '01a0f000-0000-7000-8000-0000000000d1';
const ACCOUNT_ID = '01a0f000-0000-7000-8000-0000000000a1';
const NOW = '2026-10-10T10:00:00.000Z';
const WINDOW_END = '2026-10-10T11:30:00.000Z';
const EARLIER = '2026-10-09T10:00:00.000Z';

const REGISTRATION = { id: ENTRY_ID, dateId: DATE_ID, accountId: ACCOUNT_ID };

function restored(overrides: Partial<WaitlistEntrySnapshot>): WaitlistEntry {
  return WaitlistEntry.restore({
    ...REGISTRATION,
    state: WaitlistEntryState.WAITING,
    joinedAt: EARLIER,
    notifiedAt: null,
    endedAt: null,
    version: 2,
    ...overrides,
  });
}

describe('WaitlistEntry', () => {
  it('joins waiting while no window is open, with no rank and no window', () => {
    const entry = WaitlistEntry.join(REGISTRATION, null, NOW);

    expect(entry.snapshot).toEqual({
      ...REGISTRATION,
      state: WaitlistEntryState.WAITING,
      joinedAt: NOW,
      notifiedAt: null,
      endedAt: null,
      version: 1,
    });
    expect(entry.isOnList).toBe(true);
    expect(entry.getUncommittedEvents()).toEqual([
      new WaitlistJoined(ENTRY_ID, DATE_ID, ACCOUNT_ID, WaitlistEntryState.WAITING, null, NOW),
    ]);
  });

  it('joins notified at once into an open window, naming its end', () => {
    const entry = WaitlistEntry.join(REGISTRATION, WINDOW_END, NOW);

    expect([entry.snapshot.state, entry.snapshot.notifiedAt]).toEqual([
      WaitlistEntryState.NOTIFIED,
      NOW,
    ]);
    expect(entry.getUncommittedEvents()).toEqual([
      new WaitlistJoined(
        ENTRY_ID,
        DATE_ID,
        ACCOUNT_ID,
        WaitlistEntryState.NOTIFIED,
        WINDOW_END,
        NOW,
      ),
    ]);
  });

  it('joins waiting into a window ended by time and not swept yet', () => {
    expect(WaitlistEntry.join(REGISTRATION, NOW, NOW).snapshot.state).toBe(
      WaitlistEntryState.WAITING,
    );
  });

  it.each([WaitlistEntryState.LEFT, WaitlistEntryState.LAPSED, WaitlistEntryState.CONVERTED])(
    'registers again from %s on the same row, its last end cleared',
    (state) => {
      const entry = restored({ state, notifiedAt: EARLIER, endedAt: EARLIER });

      entry.rejoin(null, NOW);

      expect(entry.snapshot).toEqual({
        ...REGISTRATION,
        state: WaitlistEntryState.WAITING,
        joinedAt: NOW,
        notifiedAt: null,
        endedAt: null,
        version: 3,
      });
    },
  );

  it('refuses to register again a closed entry, which never moves', () => {
    expect(() => restored({ state: WaitlistEntryState.CLOSED }).rejoin(null, NOW)).toThrow(
      /cannot move from closed/,
    );
  });

  it.each([WaitlistEntryState.WAITING, WaitlistEntryState.NOTIFIED])(
    'leaves from %s, giving up any window',
    (state) => {
      const entry = restored({ state });

      expect(entry.leave(NOW)).toBe(true);

      expect([entry.snapshot.state, entry.snapshot.endedAt, entry.snapshot.version]).toEqual([
        WaitlistEntryState.LEFT,
        NOW,
        3,
      ]);
      expect(entry.isOnList).toBe(false);
      expect(entry.getUncommittedEvents()).toEqual([
        new WaitlistLeft(ENTRY_ID, DATE_ID, ACCOUNT_ID, NOW),
      ]);
    },
  );

  it.each([
    WaitlistEntryState.LEFT,
    WaitlistEntryState.LAPSED,
    WaitlistEntryState.CONVERTED,
    WaitlistEntryState.CLOSED,
  ])('leaves replayed from %s moving nothing', (state) => {
    const entry = restored({ state });

    expect(entry.leave(NOW)).toBe(false);

    expect(entry.snapshot.version).toBe(2);
    expect(entry.getUncommittedEvents()).toEqual([]);
  });
});
