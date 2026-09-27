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
  /** Null while no provision is required, or while the date has no start to count back from. */
  readonly revisableUntil: Instant | null;
}

export function technicalProvisionOf(
  capacityTotal: number,
  startsAt: Instant | null,
): TechnicalProvision {
  const required = requiresTechnicalProvision(capacityTotal);
  return {
    required,
    threshold: TECHNICAL_PROVISION_THRESHOLD,
    revisableUntil: required && startsAt !== null ? provisionRevisableUntil(startsAt) : null,
  };
}
