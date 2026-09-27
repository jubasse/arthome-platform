import { RefusalException } from '@arthome-platform/http-edge';
import { HttpStatus } from '@nestjs/common';

import { isDomainError } from '@arthome/core';

import { PublicationChecklistIncomplete } from './publication.js';

/**
 * The date commands answer every refusal 409, as the contract's `moveDatePublicationState` and
 *   `decideDateOutcome`: the aggregate's decisions and the version-conditional save alike.
 */
export async function asConflict<T>(command: () => Promise<T>): Promise<T> {
  try {
    return await command();
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
