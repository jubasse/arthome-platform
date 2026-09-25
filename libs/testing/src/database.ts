/**
 * A service's schema, built the way production builds it, and emptied between
 * tests.
 *
 * ⚠ THE SCHEMA COMES FROM THE MIGRATIONS AND NEVER FROM `synchronize`. TypeORM
 *   can derive a schema from the entities in one call, and it is the wrong call
 *   twice over: on a CDC-captured table it drops and recreates columns, which
 *   breaks replication with no migration to review (data-model.md §7.4); and in
 *   a test it means the migrations — the things that will actually run against
 *   production — are never executed at all. A green suite would then say nothing
 *   about the one file that can break the database.
 */

import { DataSource, type DataSourceOptions } from 'typeorm';

import type { PostgresEndpoint } from './stack.js';

/** The entities and migrations of one service, as its `data-source.ts` declares them. */
export interface MigrationPlan {
  readonly entities: NonNullable<DataSourceOptions['entities']>;
  readonly migrations: NonNullable<DataSourceOptions['migrations']>;
}

/**
 * TypeORM's own bookkeeping table. Spared by `truncateAll`, and the reason is
 * worth a line: see below.
 */
const MIGRATIONS_TABLE = 'migrations';

/**
 * A database name is an IDENTIFIER, and an identifier cannot be a bind
 * parameter. `CREATE DATABASE $1` is a syntax error, so the name has to be
 * interpolated — which is exactly the shape that makes injection possible. It is
 * therefore checked against what Postgres accepts unquoted before it is used,
 * and refused loudly rather than quoted and hoped for.
 */
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * A database of its own for one test file, created fresh.
 *
 * ⚠ DROPPED FIRST, AND `WITH (FORCE)`. A rerun after a crashed test finds the
 *   database still there and, worse, still connected to: plain `DROP DATABASE`
 *   fails with "is being accessed by other users", which reads like a
 *   permissions problem and is a leftover connection from the run before.
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
    // Neither statement can run inside a transaction, which is why they go
    // through `query` and not through `transaction`.
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
 * Bring a database up to date with a service's migrations, and hand back the
 * connection that did it.
 *
 * The caller owns the returned `DataSource` and must `destroy()` it: a Node
 * process with a live pool does not exit, and a test runner that will not exit
 * looks exactly like a test that hangs.
 *
 * `transaction: 'each'` rather than `'all'`: a migration that cannot run inside
 * a transaction — `CREATE INDEX CONCURRENTLY`, some extension installs — fails
 * under `'all'` with an error about the statement rather than about the mode.
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
 * Empty every table, so the next test starts from nothing.
 *
 * ⚠ THE MIGRATIONS TABLE IS SPARED, AND FORGETTING THAT COSTS AN HOUR. Emptied,
 *   it tells TypeORM that nothing has ever run, so the next `runMigrations`
 *   replays `CREATE TABLE` against a schema that still holds every table — and
 *   the suite dies on "relation already exists", in a different test from the
 *   one that truncated.
 *
 * ⚠ `RESTART IDENTITY` because a sequence survives a truncate otherwise, and a
 *   test that asserts on a generated number would then depend on how many tests
 *   ran before it — which is a test that passes alone and fails in the suite.
 *
 * ⚠ `CASCADE` because truncating in dependency order by hand is a second model
 *   of the schema, kept by hand, next to the real one.
 *
 * ⚠ AND A TRUNCATE IS NOT A NO-OP FOR REPLICATION. Logical decoding carries
 *   TRUNCATE as its own message, so this is safe here — the harness's Postgres
 *   has no connector attached — and it is precisely why between-test cleanup
 *   belongs to a throwaway container and not to a script pointed at the
 *   development stack.
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
