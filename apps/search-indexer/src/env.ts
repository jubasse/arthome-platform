import { readSearchIndexerEnv, type SearchIndexerEnv } from '@arthome-platform/config';

/**
 * Parsed at module load, not in the bootstrap: the migration CLI loads `data-source.ts`
 *   with no `main()` to run, and would otherwise read an unvalidated environment.
 */
export const env: SearchIndexerEnv = readSearchIndexerEnv('search');
