import { describe, expect, it } from 'vitest';

import { plusSeconds, type Instant } from '@arthome/core';

import {
  holdsAScreen,
  leasesTakenOverBy,
  newerScreensThan,
  resumableLeaseOf,
  type ScreenLease,
} from './screen-allowance.js';

const NOW: Instant = '2026-12-12T19:30:00.000Z';
const at = (seconds: number): Instant => plusSeconds(NOW, seconds);

function lease(id: string, deviceId: string, opened: number, renewed: number): ScreenLease {
  return {
    id: `00000000-0000-7000-8000-00000000000${id}`,
    deviceId,
    openedAt: at(opened),
    lastRenewedAt: at(renewed),
    leaseExpiresAt: at(renewed + 90),
  };
}

describe('holdsAScreen', () => {
  it('holds until its lease expires, and not at that instant', () => {
    const held = lease('1', 'tv', -60, -89);
    expect(holdsAScreen(held, NOW)).toBe(true);
    expect(holdsAScreen(held, at(1))).toBe(false);
  });
});

describe('resumableLeaseOf', () => {
  it("finds the device's own unlapsed lease", () => {
    const own = lease('1', 'tv', -60, -10);
    expect(resumableLeaseOf([lease('2', 'phone', -30, -5), own], 'tv', NOW)).toBe(own);
  });

  it('resumes no lapsed lease: a new session opens', () => {
    expect(resumableLeaseOf([lease('1', 'tv', -300, -95)], 'tv', NOW)).toBeNull();
  });
});

describe('leasesTakenOverBy', () => {
  it('takes nothing while the other screens stay under the allowance', () => {
    expect(leasesTakenOverBy([lease('1', 'tv', -60, -10)], 2)).toEqual([]);
  });

  it('takes the least recently renewed when the others reach the allowance (D-117)', () => {
    const stale = lease('1', 'tv', -60, -40);
    const fresh = lease('2', 'phone', -100, -5);
    expect(leasesTakenOverBy([fresh, stale], 2)).toEqual([stale]);
  });

  it('breaks a renewal tie on the earliest opened, then the smallest id', () => {
    const early = lease('3', 'tv', -90, -10);
    const late = lease('1', 'phone', -30, -10);
    expect(leasesTakenOverBy([late, early], 1)).toEqual([early, late]);
    const left = lease('1', 'tv', -30, -10);
    const right = lease('2', 'phone', -30, -10);
    expect(leasesTakenOverBy([right, left], 2)).toEqual([left]);
  });

  it('takes as many as the allowance fell below, so the opening is never refused for it', () => {
    const screens = [
      lease('1', 'a', -90, -30),
      lease('2', 'b', -80, -20),
      lease('3', 'c', -70, -10),
    ];
    expect(leasesTakenOverBy(screens, 1).map(({ deviceId }) => deviceId)).toEqual(['a', 'b', 'c']);
    expect(leasesTakenOverBy(screens, 2).map(({ deviceId }) => deviceId)).toEqual(['a', 'b']);
  });
});

describe('newerScreensThan', () => {
  it('counts the screens opened after this one, by opening then id', () => {
    const oldest = lease('1', 'a', -90, -5);
    const middle = lease('2', 'b', -60, -40);
    const twin = lease('3', 'c', -60, -40);
    const screens = [oldest, middle, twin];
    expect(newerScreensThan(oldest, screens, NOW)).toBe(2);
    expect(newerScreensThan(middle, screens, NOW)).toBe(1);
    expect(newerScreensThan(twin, screens, NOW)).toBe(0);
  });

  it('counts no lapsed lease: every count reads the lease, never the sweep', () => {
    const oldest = lease('1', 'a', -300, -5);
    const lapsed = lease('2', 'b', -200, -100);
    expect(newerScreensThan(oldest, [oldest, lapsed], NOW)).toBe(0);
  });
});
