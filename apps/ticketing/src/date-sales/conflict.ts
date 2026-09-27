import { RefusalException } from '@arthome-platform/http-edge';
import { HttpStatus } from '@nestjs/common';

import { isDomainError } from '@arthome/core';

/**
 * The studio commands answer the aggregate's refusals and the version-conditional save's as 409,
 *   as `setDatePrices` and `openCapacityTier` do: a stale version, `date.prices_locked`,
 *   `capacity.tier_must_widen`. Any other `DomainError` stays unwrapped, 400 through the filter.
 */
export async function asConflict<T>(decide: () => T | Promise<T>): Promise<T> {
  try {
    return await decide();
  } catch (error) {
    if (!isDomainError(error)) throw error;
    throw new RefusalException(HttpStatus.CONFLICT, {
      code: error.code,
      params: error.params,
      nature: error.nature,
    });
  }
}
