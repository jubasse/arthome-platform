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
import { HoldsAndOrders1790440500000 } from './migrations/1790440500000-holds-and-orders.js';
import { PendingOrderExpiry1790440600000 } from './migrations/1790440600000-pending-order-expiry.js';
import { PaymentEventInbox1790440700000 } from './migrations/1790440700000-payment-event-inbox.js';
import { SalesEnd1790440800000 } from './migrations/1790440800000-sales-end.js';
import { SeatSalesCutoff1790440900000 } from './migrations/1790440900000-seat-sales-cutoff.js';
import { ProviderCallRetries1790441000000 } from './migrations/1790441000000-provider-call-retries.js';
import { SeatOrderHold1790441100000 } from './migrations/1790441100000-seat-order-hold.js';
import { ProviderCallQueues1790441200000 } from './migrations/1790441200000-provider-call-queues.js';
import { OrderRefundRow } from './orders/order-refund.entity.js';
import { SeatHoldRow } from './orders/seat-hold.entity.js';
import { SeatOrderRow } from './orders/seat-order.entity.js';
import { SeatRow } from './orders/seat.entity.js';

/**
 * Used by the four processes AND by the migration CLI. `synchronize` stays false: it would drop
 *   and recreate columns to match the entities, breaking the connector with no migration to
 *   review (data-model.md §7.4).
 */
export const dataSource: DataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_URL,
  entities: [
    DateSalesRow,
    DateAvailabilityPublicationRow,
    SeatHoldRow,
    SeatOrderRow,
    SeatRow,
    OrderRefundRow,
    ProcessedMessage,
    OutboxEvent,
  ],
  migrations: [
    Initial1790440000000,
    AvailabilityPublication1790440100000,
    AvailabilityPublicationFailure1790440200000,
    TechnicalProvision1790440300000,
    AvailabilityScan1790440400000,
    HoldsAndOrders1790440500000,
    PendingOrderExpiry1790440600000,
    PaymentEventInbox1790440700000,
    SalesEnd1790440800000,
    SeatSalesCutoff1790440900000,
    ProviderCallRetries1790441000000,
    SeatOrderHold1790441100000,
    ProviderCallQueues1790441200000,
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
