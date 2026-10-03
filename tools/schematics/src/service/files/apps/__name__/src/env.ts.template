import { readHttpServiceEnv, type HttpServiceEnv } from '@arthome-platform/config';

import { SERVICE } from './service.js';

/**
 * Parsed at module load: the migration CLI loads `data-source.ts` with no bootstrap to run, and
 *   every process reads the same database settings.
 */
export const env: HttpServiceEnv = readHttpServiceEnv(SERVICE);
