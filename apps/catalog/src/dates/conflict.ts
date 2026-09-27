import { RefusalException } from '@arthome-platform/http-edge';
import { HttpStatus } from '@nestjs/common';

import { isDomainError } from '@arthome/core';

import { PublicationChecklistIncomplete } from './publication.js';

/**
 * The date commands answer the aggregate's refusals and the version-conditional save's 409, as the
 *   contract's `moveDatePublicationState` and `decideDateOutcome`. Only those two are wrapped: any
 *   other `DomainError` in a handler is a fault in what it was sent, 400 through the filter.
 */
export async function asConflict<T>(decide: () => T | Promise<T>): Promise<T> {
  try {
    return await decide();
  } catch (error) {
    if (!isDomainError(error)) throw error;
    throw new RefusalException(HttpStatus.CONFLICT, {
      code: error.code,
      params:
        error instanceof PublicationChecklistIncomplete ? { missing: error.missing } : error.params,
      nature: error.nature,
    });
  }
}
