import { RefusalException } from '@arthome-platform/http-edge';
import { HttpStatus } from '@nestjs/common';

import { ApiErrorCode, DomainErrorCode, FailureNature, type MessageParams } from '@arthome/core';

/** api.not_found is "a route that does not resolve", which is exactly what a dead link is too. */
export function notFound(): RefusalException {
  return new RefusalException(HttpStatus.NOT_FOUND, {
    code: ApiErrorCode.NOT_FOUND,
    params: {},
    nature: FailureNature.REFUSED,
  });
}

/** A command sent against a version that has moved, naming what the caller must read again. */
export function stateConflict(params: MessageParams): RefusalException {
  return new RefusalException(HttpStatus.CONFLICT, {
    code: DomainErrorCode.STATE_CONFLICT,
    params,
    nature: FailureNature.REFUSED,
  });
}
