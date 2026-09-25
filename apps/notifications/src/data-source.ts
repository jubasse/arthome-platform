import { DataSource } from 'typeorm';

import { Service } from '@arthome/core';

import { ProcessedMessage } from './consumer/processed-message.entity.js';
import { WelcomeEmail } from './consumer/welcome-email.entity.js';
import { env } from './env.js';
import { Initial1758700100000 } from './migrations/1758700100000-initial.js';

export const dataSource: DataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_URL,
  entities: [ProcessedMessage, WelcomeEmail],
  migrations: [Initial1758700100000],
  /**
   * ⚠ NAMED SO `pg_stat_activity` CAN ANSWER "WHO HOLDS THIS LOCK". Four services and
   *   Debezium share one server; without this every row says `node` and a blocked
   *   migration cannot be traced to the service blocking it.
   */
  applicationName: Service.NOTIFICATIONS,

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
