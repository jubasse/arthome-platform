import { OutboxEvent, ProcessedMessage } from '@arthome-platform/messaging';
import { DataSource } from 'typeorm';

import { Service } from '@arthome/core';

import { DateAvailabilityPublicationRow } from './availability/date-availability-publication.entity.js';
import { DateSalesRow } from './date-sales/date-sales.entity.js';
import { env } from './env.js';
import { Initial1790440000000 } from './migrations/1790440000000-initial.js';
import { AvailabilityPublication1790440100000 } from './migrations/1790440100000-availability-publication.js';
import { AvailabilityPublicationFailure1790440200000 } from './migrations/1790440200000-availability-publication-failure.js';
import { TechnicalProvision1790440300000 } from './migrations/1790440300000-technical-provision.js';
import { AvailabilityScan1790440400000 } from './migrations/1790440400000-availability-scan.js';

/**
 * Used by the three processes AND by the migration CLI. `synchronize` stays false: it would drop
 *   and recreate columns to match the entities, breaking the connector with no migration to
 *   review (data-model.md §7.4).
 */
export const dataSource: DataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_URL,
  entities: [DateSalesRow, DateAvailabilityPublicationRow, ProcessedMessage, OutboxEvent],
  migrations: [
    Initial1790440000000,
    AvailabilityPublication1790440100000,
    AvailabilityPublicationFailure1790440200000,
    TechnicalProvision1790440300000,
    AvailabilityScan1790440400000,
  ],
  applicationName: Service.TICKETING,

  // `poolSize` × replicas × processes, plus the connector's replication connection, must stay
  //   under Postgres's `max_connections`, 100 by default.
  poolSize: 10,

  // pg waits for ever by default; the statement and idle-in-transaction timeouts live in
  //   `init-databases.sql`, since the CLI shares this DataSource.
  extra: { connectionTimeoutMillis: 10_000 },

  synchronize: false,
  logging: env.NODE_ENV === 'development',
});

// One export only: TypeORM's CLI refuses "more than one export of DataSource".
