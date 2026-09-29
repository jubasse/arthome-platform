import { describe, expect, it } from 'vitest';

import { lateEntryOf, seatSalesEndAt } from './seat-sales-window.js';

const STARTS_AT = '2026-12-12T19:00:00.000Z';

describe('the seat sales window (D-089)', () => {
  it('ends thirty minutes after the start', () => {
    expect(seatSalesEndAt(STARTS_AT)).toBe('2026-12-12T19:30:00.000Z');
  });

  it('is no late entry before the start, nor for a date with no start', () => {
    expect(lateEntryOf(STARTS_AT, '2026-12-12T18:59:59.999Z')).toBeNull();
    expect(lateEntryOf(null, STARTS_AT)).toBeNull();
  });

  it('counts the whole minutes missed from the start itself', () => {
    expect(lateEntryOf(STARTS_AT, STARTS_AT)).toEqual({
      startedAt: STARTS_AT,
      minutesElapsed: 0,
      salesEndAt: '2026-12-12T19:30:00.000Z',
    });
    expect(lateEntryOf(STARTS_AT, '2026-12-12T19:12:59.000Z')?.minutesElapsed).toBe(12);
  });
});
