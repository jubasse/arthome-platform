import { RefusalException } from '@arthome-platform/http-edge';
import { HttpStatus } from '@nestjs/common';

import { DomainErrorCode, FailureNature, isDomainError } from '@arthome/core';

import { PublicationChecklistIncomplete } from './publication.aggregate.js';
import type { PublicationRow } from './publication.entity.js';

/** The publication path answers its refusals 409, as the contract's `moveDatePublicationState`. */
export function asConflict<T>(decide: () => T): T {
  try {
    return decide();
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

export function stateConflict(current: PublicationRow): RefusalException {
  return new RefusalException(HttpStatus.CONFLICT, {
    code: DomainErrorCode.STATE_CONFLICT,
    params: { state: current.state, version: current.version },
    nature: FailureNature.REFUSED,
  });
}
