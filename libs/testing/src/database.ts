/**
 * The schema comes from the migrations, never from `synchronize`: on a
 *   CDC-captured table `synchronize` drops and recreates columns, breaking
 *   replication with no migration to review (data-model.md §7.4), and it leaves
 *   the migrations — the files that run against production — untested.
 */

import { DataSource, type DataSourceOptions } from 'typeorm';

import type { PostgresEndpoint } from './stack.js';

export interface MigrationPlan {
  readonly entities: NonNullable<DataSourceOptions['entities']>;
  readonly migrations: NonNullable<DataSourceOptions['migrations']>;
}

const MIGRATIONS_TABLE = 'migrations';

// A database name is an identifier, so `CREATE DATABASE $1` is a syntax error and
// the name must be interpolated: checked here rather than quoted and hoped for.
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Dropped first, and `WITH (FORCE)`: after a crashed test the database is
 *   still there and still connected to, and plain `DROP DATABASE` fails with "is
 *   being accessed by other users", which reads like a permissions problem.
 */
export async function createDatabase(
  server: PostgresEndpoint,
  name: string,
): Promise<PostgresEndpoint> {
  if (!DATABASE_NAME.test(name)) {
    throw new Error(
      `\`${name}\` is not usable as a database name here: lowercase letters, digits and ` +
        'underscores, starting with a letter or an underscore.',
    );
  }

  const admin = new DataSource({
    type: 'postgres',
    url: server.url,
    synchronize: false,
    logging: false,
  });
  await admin.initialize();
  try {
    // Neither statement can run inside a transaction.
    await admin.query<unknown>(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query<unknown>(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.destroy();
  }

  return {
    host: server.host,
    port: server.port,
    user: server.user,
    password: server.password,
    database: name,
    url: `postgres://${server.user}:${server.password}@${server.host}:${server.port}/${name}`,
  };
}

/**
 * The caller owns the returned `DataSource` and must `destroy()` it: a live
 *   pool keeps Node alive, and a runner that will not exit looks like a hang.
 *
 * `transaction: 'each'`: a migration that cannot run inside one — `CREATE INDEX
 * CONCURRENTLY` — fails under `'all'` complaining about the statement.
 */
export async function applyMigrations(
  target: PostgresEndpoint,
  plan: MigrationPlan,
): Promise<DataSource> {
  const dataSource = new DataSource({
    type: 'postgres',
    url: target.url,
    entities: plan.entities,
    migrations: plan.migrations,
    synchronize: false,
    logging: false,
  });
  await dataSource.initialize();
  await dataSource.runMigrations({ transaction: 'each' });
  return dataSource;
}

/**
 * The migrations table is spared: emptied, it tells TypeORM nothing has ever
 *   run, and the next `runMigrations` replays `CREATE TABLE` against a schema
 *   that still holds every table — failing in a different test from this one.
 *
 * `RESTART IDENTITY` so a test asserting on a generated number does not depend on
 * how many tests ran before it; `CASCADE` so dependency order is not a second
 * model of the schema kept by hand.
 */
export async function truncateAll(
  dataSource: DataSource,
  spare: readonly string[] = [],
): Promise<void> {
  const tables = await dataSource.query<{ tablename: string }[]>(
    'SELECT tablename FROM pg_tables WHERE schemaname = current_schema()',
  );

  const spared = new Set<string>([MIGRATIONS_TABLE, ...spare]);
  const targets = tables.map((row) => row.tablename).filter((name) => !spared.has(name));
  if (targets.length === 0) return;

  await dataSource.query<unknown>(
    `TRUNCATE TABLE ${targets.map((name) => `"${name}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}
