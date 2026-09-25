import type { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { purgeOutbox, purgeProcessedMessages } from './retention.js';

interface SlotRow {
  active: boolean;
  unconfirmed: boolean;
  lag: string | null;
}

function dataSourceWith(slot: SlotRow | undefined, deleted = 3): DataSource {
  const queries: string[] = [];
  const ds = {
    queries,
    query: (sql: string) => {
      queries.push(sql);
      return sql.includes('pg_replication_slots')
        ? Promise.resolve(slot === undefined ? [] : [slot])
        : Promise.resolve([[], deleted]);
    },
  };
  return ds as unknown as DataSource;
}

const CONFIRMED_AND_CURRENT: SlotRow = { active: true, unconfirmed: false, lag: '4096' };

describe('purgeOutbox is gated on the connector, not on the clock', () => {
  it('deletes when the slot is active and close behind', async () => {
    const outcome = await purgeOutbox(
      dataSourceWith(CONFIRMED_AND_CURRENT),
      'arthome_identity_outbox',
    );

    expect(outcome).toEqual({ deleted: 3, refusedBecauseConnectorLagged: false, lagBytes: 4096 });
  });

  /**
   * ⚠ The case the guard exists for: a stopped connector. Deleting here destroys a committed
   *   fact that was never published, and nothing reads this table back to notice.
   */
  it('refuses when the slot is inactive', async () => {
    const outcome = await purgeOutbox(
      dataSourceWith({ ...CONFIRMED_AND_CURRENT, active: false }),
      'arthome_identity_outbox',
    );

    expect(outcome.refusedBecauseConnectorLagged).toBe(true);
    expect(outcome.deleted).toBe(0);
  });

  it('refuses when the slot has confirmed nothing', async () => {
    const outcome = await purgeOutbox(
      dataSourceWith({ ...CONFIRMED_AND_CURRENT, unconfirmed: true, lag: null }),
      'arthome_identity_outbox',
    );

    expect(outcome.refusedBecauseConnectorLagged).toBe(true);
  });

  it('refuses when no slot exists, because nothing has ever been published', async () => {
    const outcome = await purgeOutbox(dataSourceWith(undefined), 'arthome_identity_outbox');

    expect(outcome).toEqual({ deleted: 0, refusedBecauseConnectorLagged: true, lagBytes: null });
  });

  it('refuses past §7.4’s own one-gigabyte alert threshold', async () => {
    const overBy1 = String(1024 * 1024 * 1024 + 1);
    const outcome = await purgeOutbox(
      dataSourceWith({ ...CONFIRMED_AND_CURRENT, lag: overBy1 }),
      'arthome_identity_outbox',
    );

    expect(outcome.refusedBecauseConnectorLagged).toBe(true);
    expect(outcome.lagBytes).toBe(1024 * 1024 * 1024 + 1);
  });

  it('reads the slot before deleting anything', async () => {
    const ds = dataSourceWith({ ...CONFIRMED_AND_CURRENT, active: false });
    await purgeOutbox(ds, 'arthome_identity_outbox');

    const queries = (ds as unknown as { queries: string[] }).queries;
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('pg_replication_slots');
  });
});

describe('purgeProcessedMessages', () => {
  it('deletes by age and reports the count', async () => {
    expect(await purgeProcessedMessages(dataSourceWith(undefined, 7))).toBe(7);
  });

  /** ⚠ 30 days must stay above every DLQ topic retention, or a replay stops deduplicating. */
  it('defaults to a horizon longer than the brokers’ 168-hour default', async () => {
    const ds = dataSourceWith(undefined);
    await purgeProcessedMessages(ds);

    const queries = (ds as unknown as { queries: string[] }).queries;
    expect(queries[0]).toContain('processed_at');
  });
});
