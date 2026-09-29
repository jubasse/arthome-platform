import type { Instant } from '@arthome/core';

/** The contract's example, `ATH-2026-00042`, until core states a format (HANDOVER §3). */
export function interimOrderReferenceOf(placedAt: Instant, sequence: number): string {
  return `ATH-${placedAt.slice(0, 4)}-${String(sequence).padStart(5, '0')}`;
}
