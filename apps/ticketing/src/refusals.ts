import { RefusalException } from '@arthome-platform/http-edge';
import { HttpStatus } from '@nestjs/common';

import { ApiErrorCode, FailureNature } from '@arthome/core';

export function notFound(): RefusalException {
  return new RefusalException(HttpStatus.NOT_FOUND, {
    code: ApiErrorCode.NOT_FOUND,
    params: {},
    nature: FailureNature.REFUSED,
  });
}
