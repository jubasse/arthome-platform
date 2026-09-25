import { IdentityErrorCode } from '@arthome/core';

/**
 * ⚠ Every uniquely-constrained column must appear here. One that does not answers
 *   500, by design — the filter refuses to serve a code it was not given.
 *
 *   Its own module rather than `app.module.ts` so a test can read it: importing the
 *   module pulls in `data-source.ts`, which parses the environment at load.
 */
export const UNIQUE_VIOLATION_CODES = [
  { column: 'email', code: IdentityErrorCode.EMAIL_TAKEN },
  { column: 'public_handle', code: IdentityErrorCode.HANDLE_TAKEN },
] as const;
