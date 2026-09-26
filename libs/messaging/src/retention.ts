import type { DataSource } from 'typeorm';

import { MAX_SLOT_LAG_BYTES, readSlotState } from './slot.js';

export const OUTBOX_RETENTION_DAYS = 7;

/**
 * Must outlive every way a message can come back (§7.5): the retry budget, a dead-lettered
 * message waiting to be replayed, a consumer group rewound. Purged sooner, a replay finds no row
 * and the effect is applied twice in silence. Past its topic's retention a message cannot come
 * back at all, so `topic-retention.spec.ts` holds every topic below this.
 */
export const PROCESSED_MESSAGE_RETENTION_DAYS = 30;

export interface PurgeOutcome {
  readonly deleted: number;
  readonly refusedBecauseConnectorLagged: boolean;
  readonly lagBytes: number | null;
}

/**
 * GATED ON THE CONNECTOR, NOT ON THE CLOCK (§7.5). Deleting a row Debezium has not read
 *   destroys a committed business fact that was never published, and the application never
 *   reads this table back, so nothing notices — ever.
 *
 * A row carries no LSN, so "has the connector passed this row" is not directly askable.
 *   The lag is the proxy that makes it safe: a row older than the retention whose insert is
 *   still unconfirmed means the connector is behind by at least the retention, which a lag
 *   far under a gigabyte cannot be. An inactive slot refuses outright — a stopped connector
 *   is the case this guard exists for.
 */
export async function purgeOutbox(
  dataSource: DataSource,
  slotName: string,
  retentionDays: number = OUTBOX_RETENTION_DAYS,
): Promise<PurgeOutcome> {
  const slot = await readSlotState(dataSource, slotName);

  // No slot means no connector has ever read this table: nothing here has been published.
  if (slot === undefined || slot.unconfirmed || !slot.active) {
    return { deleted: 0, refusedBecauseConnectorLagged: true, lagBytes: null };
  }

  const { lagBytes } = slot;
  if (lagBytes > MAX_SLOT_LAG_BYTES) {
    return { deleted: 0, refusedBecauseConnectorLagged: true, lagBytes };
  }

  const result: unknown = await dataSource.query(
    `DELETE FROM outbox_event WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(retentionDays)],
  );

  return {
    deleted: deletedCountOf(result),
    refusedBecauseConnectorLagged: false,
    lagBytes,
  };
}

export async function purgeProcessedMessages(
  dataSource: DataSource,
  retentionDays: number = PROCESSED_MESSAGE_RETENTION_DAYS,
): Promise<number> {
  const result: unknown = await dataSource.query(
    `DELETE FROM processed_message WHERE processed_at < now() - ($1 || ' days')::interval`,
    [String(retentionDays)],
  );
  return deletedCountOf(result);
}

// pg returns [rows, rowCount] for DELETE; the rows array is empty without RETURNING.
function deletedCountOf(result: unknown): number {
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}
