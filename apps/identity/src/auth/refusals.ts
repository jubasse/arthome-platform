import { refusalOf, type RefusalException } from '@arthome-platform/http-edge';

import { IdentityErrorCode } from '@arthome/core';

/** Auth Q1: the status says the address is registered; the BFF's rate limit is what bounds it. */
export const emailTaken = (): RefusalException => refusalOf(IdentityErrorCode.EMAIL_TAKEN);

/** One answer for an unknown email, a wrong password and an account that may not sign in. */
export const invalidCredentials = (): RefusalException =>
  refusalOf(IdentityErrorCode.INVALID_CREDENTIALS);

/** Unknown, expired or already used: one answer, `adr-auth.md` §6.7. */
export const verificationLinkInvalid = (): RefusalException =>
  refusalOf(IdentityErrorCode.VERIFICATION_LINK_INVALID);
