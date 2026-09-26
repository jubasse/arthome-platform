import { OutboxEvent } from '@arthome-platform/messaging';
import { DataSource } from 'typeorm';

import { Service } from '@arthome/core';

import { Show } from './catalog/show.entity.js';
import { env } from './env.js';
import { Initial1758800000000 } from './migrations/1758800000000-initial.js';
import { Idempotency1790420000000 } from './migrations/1790420000000-idempotency.js';

/**
 * Used by the application AND by the migration CLI.
 *
 * `synchronize` stays false: it would drop and recreate columns to match the entities,
 *   breaking the connector with no migration to review (data-model.md §7.4).
 */
export const dataSource: DataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_URL,
  entities: [Show, OutboxEvent],
  migrations: [Initial1758800000000, Idempotency1790420000000],
  applicationName: Service.CATALOG,

  // `poolSize` × replicas, plus one replication connection per registered connector, must
  //   stay under Postgres's `max_connections` — default 100.
  poolSize: 10,

  // pg waits FOR EVER by default: a service started against a dead Postgres hung in
  //   `initialize()` with nothing to restart it. The statement and idle-in-transaction
  //   timeouts live in `init-databases.sql`, since the CLI shares this DataSource and they
  //   would kill a backfill.
  extra: { connectionTimeoutMillis: 10_000 },

  synchronize: false,
  logging: env.NODE_ENV === 'development',
});

// One export only: TypeORM's CLI refuses "more than one export of DataSource".
