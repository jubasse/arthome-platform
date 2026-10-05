import { getMigrations } from 'better-auth/db/migration';
import type { Pool } from 'pg';

import { authOptions } from './better-auth.js';

/**
 * better-auth's own migrator over the `auth` schema, which it creates first. The second of the two
 *   migration commands R2 names (`adr-auth.md` §10), never interleaved with TypeORM's: it reads only
 *   `auth`, TypeORM's only `public`, so either order works, and both are run before the API starts.
 *   It refuses to add a required column with no default to a populated table rather than guess.
 */
export async function migrateAuthSchema(pool: Pool, secret: string): Promise<void> {
  const { runMigrations } = await getMigrations(authOptions(pool, secret));
  await runMigrations();
}
