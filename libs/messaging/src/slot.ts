import type { DataSource } from 'typeorm';

/** data-model.md §7.4's alert threshold: a slot lagging more than this is already a page. */
export const MAX_SLOT_LAG_BYTES: number = 1024 * 1024 * 1024;

export interface SlotState {
  readonly active: boolean;
  readonly unconfirmed: boolean;
  readonly lagBytes: number;
}

/** `undefined` when no slot of that name exists: no connector has ever read this database. */
export async function readSlotState(
  dataSource: DataSource,
  slotName: string,
): Promise<SlotState | undefined> {
  const rows = (await dataSource.query(
    `SELECT active, confirmed_flush_lsn IS NULL AS unconfirmed,
            pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::bigint AS lag
       FROM pg_replication_slots WHERE slot_name = $1`,
    [slotName],
  )) as unknown as { active: boolean; unconfirmed: boolean; lag: string | null }[];

  const [row] = rows;
  if (row === undefined) return undefined;
  return { active: row.active, unconfirmed: row.unconfirmed, lagBytes: Number(row.lag ?? 0) };
}

/**
 * data-model.md §7.4 names each connector's slot and publication `arthome_<service>_outbox`, and
 * the Debezium config in `infra/debezium/` repeats it — that file is the one to keep in step.
 */
export function outboxSlotName(service: string): string {
  return `arthome_${service}_outbox`;
}
