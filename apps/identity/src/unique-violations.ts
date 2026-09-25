import { IdentityErrorCode } from '@arthome/core';

// ⚠ Every uniquely-constrained column must appear here: one that does not answers 500.
// Its own module so a test can import it without `data-source.ts` parsing the environment.
export const UNIQUE_VIOLATION_CODES = [
  { column: 'email', code: IdentityErrorCode.EMAIL_TAKEN },
  { column: 'public_handle', code: IdentityErrorCode.HANDLE_TAKEN },
] as const;
