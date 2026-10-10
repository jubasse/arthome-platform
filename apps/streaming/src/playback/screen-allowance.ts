import { isAfter, toEpochMs, type Instant } from '@arthome/core';

/** An active lease of the account on the date, as the screens' decisions read it. */
export interface ScreenLease {
  readonly id: string;
  readonly deviceId: string;
  readonly openedAt: Instant;
  readonly lastRenewedAt: Instant;
  readonly leaseExpiresAt: Instant;
}

/** Still holding a screen: every count reads `lease_expires_at > now`, never the sweep. */
export function holdsAScreen(lease: ScreenLease, now: Instant): boolean {
  return isAfter(lease.leaseExpiresAt, now);
}

/** The device's own unlapsed lease, which an opening on that device takes over (resumption). */
export function resumableLeaseOf(
  leases: readonly ScreenLease[],
  deviceId: string,
  now: Instant,
): ScreenLease | null {
  return leases.find((lease) => lease.deviceId === deviceId && holdsAScreen(lease, now)) ?? null;
}

/** Postgres orders uuids by their bytes, which is the order of their lowercase hex. */
function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function byLeastRecentlyRenewed(left: ScreenLease, right: ScreenLease): number {
  return (
    toEpochMs(left.lastRenewedAt) - toEpochMs(right.lastRenewedAt) ||
    toEpochMs(left.openedAt) - toEpochMs(right.openedAt) ||
    compareIds(left.id, right.id)
  );
}

/**
 * D-117: the other screens an opening takes over so that it fits under the allowance, least
 *   recently renewed first. Usually one; more only when the allowance fell below the screens
 *   already open (a seat cancelled), so an opening is never refused for the ceiling while a lease
 *   remains to take over (C2 R7).
 */
export function leasesTakenOverBy(
  otherScreens: readonly ScreenLease[],
  allowed: number,
): ScreenLease[] {
  const excess = otherScreens.length - Math.max(0, allowed - 1);
  if (excess <= 0) return [];
  return [...otherScreens].sort(byLeastRecentlyRenewed).slice(0, excess);
}

function openedLater(lease: ScreenLease, than: ScreenLease): boolean {
  const difference = toEpochMs(lease.openedAt) - toEpochMs(than.openedAt);
  return difference > 0 || (difference === 0 && compareIds(lease.id, than.id) > 0);
}

/**
 * At a renewal, the screens opened after this one (by `opened_at`, then id): the newest keep their
 *   screens when the allowance falls, as D-117 keeps the latest opening.
 */
export function newerScreensThan(
  lease: ScreenLease,
  screens: readonly ScreenLease[],
  now: Instant,
): number {
  return screens.filter(
    (other) => other.id !== lease.id && holdsAScreen(other, now) && openedLater(other, lease),
  ).length;
}
