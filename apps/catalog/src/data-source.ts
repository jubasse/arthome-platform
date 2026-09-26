import { OutboxEvent, ProcessedMessage } from '@arthome-platform/messaging';
import { DataSource } from 'typeorm';

import { Service } from '@arthome/core';

import { Show } from './catalog/show.entity.js';
import { PerformanceDate } from './dates/performance-date.entity.js';
import { PublicationChecklistFact } from './dates/publication-checklist-fact.entity.js';
import { Publication } from './dates/publication.entity.js';
import { env } from './env.js';
import { Initial1758800000000 } from './migrations/1758800000000-initial.js';
import { Idempotency1790420000000 } from './migrations/1790420000000-idempotency.js';
import { ShowCopyAndVenue1790420100000 } from './migrations/1790420100000-show-copy-and-venue.js';
import { DateAndPublication1790420200000 } from './migrations/1790420200000-date-and-publication.js';
import { ChecklistProjection1790420300000 } from './migrations/1790420300000-checklist-projection.js';
import { DateSlugs1790420400000 } from './migrations/1790420400000-date-slugs.js';
import { IdempotencyResponseAsJson1790420500000 } from './migrations/1790420500000-idempotency-response-as-json.js';
import { Venue } from './venues/venue.entity.js';

/**
 * Used by the application AND by the migration CLI.
 *
 * `synchronize` stays false: it would drop and recreate columns to match the entities,
 *   breaking the connector with no migration to review (data-model.md §7.4).
 */
export const dataSource: DataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_URL,
  entities: [
    Show,
    Venue,
    PerformanceDate,
    Publication,
    PublicationChecklistFact,
    ProcessedMessage,
    OutboxEvent,
  ],
  migrations: [
    Initial1758800000000,
    Idempotency1790420000000,
    ShowCopyAndVenue1790420100000,
    DateAndPublication1790420200000,
    ChecklistProjection1790420300000,
    DateSlugs1790420400000,
    IdempotencyResponseAsJson1790420500000,
  ],
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
