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
  synchronize: false,
  logging: false,
});

// ⚠ ONE EXPORT, AND ONLY ONE. TypeORM's CLI loads this file and refuses it with
//   "must contain only one export of DataSource instance" if a default export
//   duplicates the named one.
