import { readHttpServiceEnv, type HttpServiceEnv } from '@arthome-platform/config';

import { Service } from '@arthome/core';

// ⚠ Parsed at module load, not in the bootstrap: the migration CLI loads `data-source.ts`
//   with no `main()` to run, and would otherwise read an unvalidated environment.
export const env: HttpServiceEnv = readHttpServiceEnv(Service.IDENTITY);
