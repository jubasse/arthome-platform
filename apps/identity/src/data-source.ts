import { readEnv } from '@arthome-platform/config';
import { OutboxEvent } from '@arthome-platform/messaging';
import { DataSource } from 'typeorm';

import { Account } from './identity/account.entity.js';
import { Initial1758700000000 } from './migrations/1758700000000-initial.js';
import { OutboxGuards1758700200000 } from './migrations/1758700200000-outbox-guards.js';

const env = readEnv();

/**
 * The DataSource, used by the application AND by the migration CLI.
 *
 * ⚠ `synchronize` IS FALSE AND STAYS FALSE. It would drop and recreate columns
 *   to match the entities, which on a table read by logical replication means
 *   breaking the connector without a migration to review (data-model.md §7.4).
 */
export const dataSource: DataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL ?? 'postgres://arthome:arthome@localhost:55432/identity',
  entities: [Account, OutboxEvent],
  migrations: [Initial1758700000000, OutboxGuards1758700200000],
  synchronize: false,
  logging: env.NODE_ENV === 'development',
});

// ⚠ ONE EXPORT, AND ONLY ONE. TypeORM's CLI loads this file and refuses it with
//   "must contain only one export of DataSource instance" if a default export
//   duplicates the named one — which is what having both looked like.
