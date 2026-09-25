import { DataSource } from 'typeorm';

import { ProcessedMessage } from './consumer/processed-message.entity.js';
import { ShowProjection } from './consumer/show-projection.entity.js';
import { env } from './env.js';
import { Initial1758700400000 } from './migrations/1758700400000-initial.js';

/**
 * The DataSource, used by the application AND by the migration CLI.
 *
 * ⚠ `synchronize` IS FALSE AND STAYS FALSE. It drops and recreates columns to
 *   match the entities, without a migration anybody reviewed.
 *
 * ⚠ THE DATABASE IS `search`, AND ITS NAME IS NOT OWNED HERE. It is created by
 *   `infra/postgres/init-databases.sql`, which is the document that owns it;
 *   this is a default for a developer running the stack on their machine, and a
 *   deployment passes `DATABASE_URL`.
 */
export const dataSource: DataSource = new DataSource({
  type: 'postgres',
  // 55432, not 5432 — see compose.yaml, and AGENTS.md for why.
  url: env.DATABASE_URL,
  entities: [ProcessedMessage, ShowProjection],
  migrations: [Initial1758700400000],
  /**
   * ⚠ NAMED SO `pg_stat_activity` CAN ANSWER "WHO HOLDS THIS LOCK". Four services and
   *   Debezium share one server; without this every row says `node` and a blocked
   *   migration cannot be traced to the service blocking it.
   */
  applicationName: 'search-indexer',

  /**
   * ⚠ `poolSize` × REPLICAS MUST STAY UNDER `max_connections`. Four services at 10
   *   each is 40, plus one replication connection per registered connector, against
   *   Postgres's default 100. That headroom is what this number spends.
   */
  poolSize: 10,

  extra: {
    /**
     * ⚠ pg WAITS FOR EVER BY DEFAULT — `connectionTimeoutMillis` is 0. A service
     *   started against a Postgres that is down never failed and never exited, so
     *   nothing could restart it: it simply hung in `initialize()`.
     *
     * ⚠ `statement_timeout` AND `idle_in_transaction_session_timeout` ARE DELIBERATELY
     *   NOT SET HERE. The migration CLI shares this DataSource, and a backfill or a
     *   long `ALTER` is exactly the statement they would kill halfway. They belong to
     *   the database, and `infra/postgres/init-databases.sql` sets them there, where a
     *   migration can lift them for its own session.
     */
    connectionTimeoutMillis: 10_000,
  },

  /**
   * ⚠ EXPLICIT, AND `'all'` IS ALSO THE DEFAULT — written down because the choice
   *   matters and the day it changes it must be a decision. One transaction for the
   *   whole batch means a failed migration leaves nothing behind, which on a table
   *   read by logical replication is what keeps the connector's column list valid.
   *
   *   ⚠ The cost: a migration needing `CREATE INDEX CONCURRENTLY` cannot run inside a
   *     transaction, and setting `transaction = false` on it throws
   *     `ForbiddenTransactionModeOverrideError` under `'all'`. That migration is the
   *     one that must flip this to `'each'`, and accept partial batches in exchange.
   */
  migrationsTransactionMode: 'all',
  synchronize: false,
  logging: false,
});

// ⚠ ONE EXPORT, AND ONLY ONE. TypeORM's CLI loads this file and refuses it with
//   "must contain only one export of DataSource instance" if a default export
//   duplicates the named one.
