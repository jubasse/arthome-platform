import { readSearchIndexerEnv, type SearchIndexerEnv } from '@arthome-platform/config';

/**
 * ⚠ PARSED HERE, AT MODULE LOAD, AND NOT IN THE BOOTSTRAP. The migration CLI loads
 *   `data-source.ts` with no `main()` to run, so a parse inside one would leave the
 *   CLI reading an unvalidated environment — which is how every service ended up
 *   reaching for `process.env` directly.
 *
 *   ⚠ `'search'` STAYS A LITERAL, and it must. This deployable is deliberately not a
 *   `SERVICES` member — nobody calls it, and a name in that constant that nothing
 *   calls makes every upstream count wrong (the reason is in `main.ts`). The value is
 *   owned by `infra/postgres/init-databases.sql`, which creates the database.
 */
export const env: SearchIndexerEnv = readSearchIndexerEnv('search');
