import type { DataSource } from 'typeorm';

interface SlotState {
  readonly active: boolean;
  readonly unconfirmed: boolean;
  readonly lag: string | null;
}

export interface PurgeOutcome {
  readonly deleted: number;
  readonly refusedBecauseConnectorLagged: boolean;
  readonly lagBytes: number | null;
}

/**
 * ⚠ data-model.md §7.4's own alert threshold, reused rather than invented: a slot lagging
 *   more than this is already a page.
 */
const MAX_SLOT_LAG_BYTES = 1024 * 1024 * 1024;

/**
 * ⚠ GATED ON THE CONNECTOR, NOT ON THE CLOCK (§7.5). Deleting a row Debezium has not read
 *   destroys a committed business fact that was never published, and the application never
 *   reads this table back, so nothing notices — ever.
 *
 * ⚠ A row carries no LSN, so "has the connector passed this row" is not directly askable.
 *   The lag is the proxy that makes it safe: a row older than the retention whose insert is
 *   still unconfirmed means the connector is behind by at least the retention, which a lag
 *   far under a gigabyte cannot be. An inactive slot refuses outright — a stopped connector
 *   is the case this guard exists for.
 */
export async function purgeOutbox(
  dataSource: DataSource,
  slotName: string,
  retentionDays = 7,
): Promise<PurgeOutcome> {
  // `query` is typed `any`; asserted through `unknown` as elsewhere in this repository.
  const slots = (await dataSource.query(
    `SELECT active, confirmed_flush_lsn IS NULL AS unconfirmed,
            pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::bigint AS lag
       FROM pg_replication_slots WHERE slot_name = $1`,
    [slotName],
  )) as unknown as SlotState[];
  const slot = slots[0];

  // No slot means no connector has ever read this table: nothing here has been published.
  if (slot === undefined || slot.unconfirmed || !slot.active) {
    return { deleted: 0, refusedBecauseConnectorLagged: true, lagBytes: null };
  }

  const lagBytes = Number(slot.lag ?? 0);
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

/**
 * ⚠ THE HORIZON MUST OUTLIVE EVERY WAY A MESSAGE CAN COME BACK (§7.5), which is the retry
 *   budget — 5 s, 30 s, 5 min — plus however long a dead-lettered message sits before
 *   somebody replays it. Purged sooner it stops deduplicating precisely the replays it
 *   exists for: the message returns, finds no row, and the effect is applied twice in
 *   silence.
 *
 * ⚠ 30 days is chosen against a real bound, not a feeling: past the DLQ topic's retention
 *   the message cannot come back at all, and no topic in `infra/kafka/topics.json` sets one,
 *   so Kafka's 168 h default applies. **Raising a DLQ retention past 30 days requires raising
 *   this**, and nothing checks that coupling.
 */
export async function purgeProcessedMessages(
  dataSource: DataSource,
  retentionDays = 30,
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
