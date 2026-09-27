// Aliased because `@arthome-platform/events` is a flat barrel: a wire enum and core's
// vocabulary share each name, and they are a number and a string.
import {
  DateOutcome as WireDateOutcome,
  PriceTier as WirePriceTier,
} from '@arthome-platform/events';

import { DATE_OUTCOMES, DateOutcome, PriceTier } from '@arthome/core';

/**
 * The domain's members → the wire's numbers. `satisfies` points at the domain: a new member in
 * core fails this build, and the proto's `UNSPECIFIED = 0` rightly has no domain member.
 */
export const WIRE_PRICE_TIER = {
  [PriceTier.FULL]: WirePriceTier.FULL,
  [PriceTier.REDUCED]: WirePriceTier.REDUCED,
  [PriceTier.SUPPORT]: WirePriceTier.SUPPORT,
} satisfies Record<PriceTier, WirePriceTier>;

const WIRE_DATE_OUTCOME = {
  [DateOutcome.POSTPONED]: WireDateOutcome.POSTPONED,
  [DateOutcome.CANCELLED]: WireDateOutcome.CANCELLED,
  [DateOutcome.INTERRUPTED]: WireDateOutcome.INTERRUPTED,
} satisfies Record<DateOutcome, WireDateOutcome>;

/** Null for `UNSPECIFIED` and for a member this build does not know: neutral, never refused. */
export function dateOutcomeOf(wire: WireDateOutcome): DateOutcome | null {
  return DATE_OUTCOMES.find((outcome) => WIRE_DATE_OUTCOME[outcome] === wire) ?? null;
}
