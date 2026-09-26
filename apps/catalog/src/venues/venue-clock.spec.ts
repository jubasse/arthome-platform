import { describe, expect, it } from 'vitest';

import { isKnownTimeZone, venueClockAt } from './venue-clock.js';

describe('venueClockAt', () => {
  it('computes the offset for the instant, across a daylight-saving change (D3)', () => {
    expect(venueClockAt('Europe/Paris', '2026-07-01T19:30:00.000Z').utcOffsetMinutes).toBe(120);
    expect(venueClockAt('Europe/Paris', '2026-11-04T19:30:00.000Z').utcOffsetMinutes).toBe(60);
  });

  it('reads a negative and a half-hour offset', () => {
    expect(venueClockAt('America/New_York', '2026-11-04T19:30:00.000Z').utcOffsetMinutes).toBe(
      -300,
    );
    expect(venueClockAt('Asia/Kolkata', '2026-11-04T19:30:00.000Z').utcOffsetMinutes).toBe(330);
  });

  it('answers zero for UTC itself', () => {
    expect(venueClockAt('Etc/UTC', '2026-11-04T19:30:00.000Z').utcOffsetMinutes).toBe(0);
  });
});

describe('isKnownTimeZone', () => {
  it('knows a real zone and refuses a well-shaped one that does not exist', () => {
    expect(isKnownTimeZone('Europe/Paris')).toBe(true);
    expect(isKnownTimeZone('Europe/Atlantis')).toBe(false);
  });
});
