import { toEpochMs, venueClock, type Instant, type VenueClock } from '@arthome/core';

/**
 * Whether this runtime knows the zone. Core validates shape only, because surfaces do not
 * bundle the IANA database; a server does, and it is the one computing offsets.
 */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The venue's clock for one instant: the offset is computed here and never stored (D3). */
export function venueClockAt(timeZone: string, instant: Instant): VenueClock {
  const epochMs = toEpochMs(instant);
  const parts = new Intl.DateTimeFormat(undefined, {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
    numberingSystem: 'latn',
  }).formatToParts(new Date(epochMs));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? 0);

  // The wall clock read back as if it were UTC, minus the instant, is the offset.
  const wallClockAsUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  const flooredToSecond = epochMs - (epochMs % 1_000);
  return venueClock(timeZone, Math.round((wallClockAsUtc - flooredToSecond) / 60_000));
}
