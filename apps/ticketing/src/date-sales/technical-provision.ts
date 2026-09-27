import {
  TECHNICAL_PROVISION_THRESHOLD,
  provisionRevisableUntil,
  requiresTechnicalProvision,
  type Instant,
} from '@arthome/core';

/** data-model.md §3.1's technical provision, as the pane and `capacity_set` state it. */
export interface TechnicalProvision {
  readonly required: boolean;
  readonly threshold: number;
  /** The capacity the recorded provision covers; null while none is recorded (D-088). */
  readonly provisionedCapacity: number | null;
  /** Null while the date has no start to count back from. */
  readonly revisableUntil: Instant | null;
}

export function technicalProvisionOf(
  capacityTotal: number,
  provisionedCapacity: number | null,
  startsAt: Instant | null,
): TechnicalProvision {
  return {
    required: requiresTechnicalProvision(capacityTotal),
    threshold: TECHNICAL_PROVISION_THRESHOLD,
    provisionedCapacity,
    revisableUntil: startsAt === null ? null : provisionRevisableUntil(startsAt),
  };
}
