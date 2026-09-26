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
  applicationName: Service.NOTIFICATIONS,

  // `poolSize` × replicas, plus one replication connection per registered
  //   connector, must stay under Postgres's `max_connections` — default 100.
  poolSize: 10,

  // pg waits FOR EVER by default: a service started against a dead Postgres hung
  //   in `initialize()` with nothing to restart it. The statement and
  //   idle-in-transaction timeouts live in `infra/postgres/init-databases.sql`, since
  //   the migration CLI shares this DataSource and they would kill a backfill.
  extra: { connectionTimeoutMillis: 10_000 },

  synchronize: false,
  logging: false,
});
