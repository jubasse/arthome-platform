import { readHttpServiceEnv, type HttpServiceEnv } from '@arthome-platform/config';

import { Service } from '@arthome/core';

/**
 * Parsed at module load: the migration CLI loads `data-source.ts` with no bootstrap to run, and
 *   the consumer and the sweeper read the same database settings.
 */
export const env: HttpServiceEnv = readHttpServiceEnv(Service.TICKETING);
