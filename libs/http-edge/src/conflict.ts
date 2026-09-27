import { HttpStatus } from '@nestjs/common';

import { isDomainError, type DomainError } from '@arthome/core';

import { RefusalException, type Refusal } from './refusal.js';

/**
 * Answers an aggregate's refusal, or its version-conditional save's, as the 409 the contract gives
 *   it, with the same `code`, `params` and `nature`. Wrap only those two calls: any other
 *   `DomainError` in a handler is a fault in what the request carried, 400 through the filter.
 *   `paramsOf` serves a refusal that carries more than core's scalar `params`, a list for one.
 */
export async function asConflict<T>(
  decide: () => T | Promise<T>,
  paramsOf: (error: DomainError) => Refusal['params'] = (error) => error.params,
): Promise<T> {
  try {
    return await decide();
  } catch (error) {
    if (!isDomainError(error)) throw error;
    throw new RefusalException(HttpStatus.CONFLICT, {
      code: error.code,
      params: paramsOf(error),
      nature: error.nature,
    });
  }
}
