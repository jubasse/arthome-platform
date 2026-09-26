import { readConsumerEnv, type ConsumerEnv } from '@arthome-platform/config';

import { Service } from '@arthome/core';

/**
 * Parsed at module load, not in the bootstrap: the migration CLI loads `data-source.ts`
 *   with no `main()` to run, so a parse inside one would leave the CLI reading an unvalidated
 *   environment — which is how every service ended up reaching for `process.env` directly.
 */
export const env: ConsumerEnv = readConsumerEnv(Service.NOTIFICATIONS);
