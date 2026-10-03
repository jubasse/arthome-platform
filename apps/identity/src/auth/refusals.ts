import { RefusalException } from '@arthome-platform/http-edge';
import { HttpStatus } from '@nestjs/common';

import { FailureNature, IdentityErrorCode } from '@arthome/core';

function refused(status: HttpStatus, code: string): RefusalException {
  return new RefusalException(status, { code, params: {}, nature: FailureNature.REFUSED });
}

/** Auth Q1: the status says the address is registered; the BFF's rate limit is what bounds it. */
export const emailTaken = (): RefusalException =>
  refused(HttpStatus.CONFLICT, IdentityErrorCode.EMAIL_TAKEN);

/** One answer for an unknown email, a wrong password and an account that may not sign in. */
export const invalidCredentials = (): RefusalException =>
  refused(HttpStatus.UNAUTHORIZED, IdentityErrorCode.INVALID_CREDENTIALS);

/** Unknown, expired or already used: one answer, `adr-auth.md` §6.7. */
export const verificationLinkInvalid = (): RefusalException =>
  refused(HttpStatus.GONE, IdentityErrorCode.VERIFICATION_LINK_INVALID);
