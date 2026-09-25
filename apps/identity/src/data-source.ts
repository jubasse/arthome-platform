import { OutboxEvent } from '@arthome-platform/messaging';
import { DataSource } from 'typeorm';

import { Service } from '@arthome/core';

import { env } from './env.js';
import { Account } from './identity/account.entity.js';
import { Initial1758700000000 } from './migrations/1758700000000-initial.js';
import { OutboxGuards1758700200000 } from './migrations/1758700200000-outbox-guards.js';

/**
 * The DataSource, used by the application AND by the migration CLI.
 *
 * ⚠ `synchronize` stays false: it would drop and recreate columns to match the
 *   entities, breaking the connector with no migration to review (data-model.md §7.4).
 */
export const dataSource: DataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_URL,
  entities: [Account, OutboxEvent],
  migrations: [Initial1758700000000, OutboxGuards1758700200000],
  applicationName: Service.IDENTITY,

  // ⚠ `poolSize` × replicas, plus one replication connection per registered
  //   connector, must stay under Postgres's `max_connections` — default 100.
  poolSize: 10,

  // ⚠ pg waits FOR EVER by default: a service started against a dead Postgres hung
  //   in `initialize()` with nothing to restart it. The statement and
  //   idle-in-transaction timeouts live in `infra/postgres/init-databases.sql`, since
  //   the migration CLI shares this DataSource and they would kill a backfill.
  extra: { connectionTimeoutMillis: 10_000 },

  synchronize: false,
  logging: env.NODE_ENV === 'development',
});

// ⚠ One export only: TypeORM's CLI refuses "more than one export of DataSource".
