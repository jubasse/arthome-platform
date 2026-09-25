import { DataSource } from 'typeorm';

import { ProcessedMessage } from './consumer/processed-message.entity.js';
import { ShowProjection } from './consumer/show-projection.entity.js';
import { env } from './env.js';
import { Initial1758700400000 } from './migrations/1758700400000-initial.js';

/**
 * The DataSource, used by the application AND by the migration CLI.
 *
 * ⚠ `synchronize` stays false: it drops and recreates columns to match the entities,
 *   with no migration anybody reviewed.
 */
export const dataSource: DataSource = new DataSource({
  type: 'postgres',
  // 55432, not 5432 — see compose.yaml, and AGENTS.md for why.
  url: env.DATABASE_URL,
  entities: [ProcessedMessage, ShowProjection],
  migrations: [Initial1758700400000],
  applicationName: 'search-indexer',

  // ⚠ `poolSize` × replicas, plus one replication connection per registered
  //   connector, must stay under Postgres's `max_connections` — default 100.
  poolSize: 10,

  // ⚠ pg waits FOR EVER by default: a service started against a dead Postgres hung
  //   in `initialize()` with nothing to restart it. The statement and
  //   idle-in-transaction timeouts live in `infra/postgres/init-databases.sql`, since
  //   the migration CLI shares this DataSource and they would kill a backfill.
  extra: { connectionTimeoutMillis: 10_000 },

  synchronize: false,
  logging: false,
});

// ⚠ One export only: TypeORM's CLI refuses "more than one export of DataSource".
