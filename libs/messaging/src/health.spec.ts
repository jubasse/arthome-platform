import type { Admin } from 'kafkajs';
import type { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';

import {
  boundedCheck,
  checkDeadLetterDepth,
  checkOutboxRetention,
  checkPublicationScope,
  checkReplicationSlot,
} from './health.js';

/** Answers each query by the first entry whose key appears in the SQL. */
function dataSourceAnswering(answers: Record<string, unknown[]>): DataSource {
  return {
    query: (sql: string) => {
      const key = Object.keys(answers).find((fragment) => sql.includes(fragment));
      return Promise.resolve(key === undefined ? [] : answers[key]);
    },
  } as unknown as DataSource;
}

describe('boundedCheck turns failure into a result, never a throw', () => {
  it('passes a success through', async () => {
    const result = await boundedCheck('x', 'down', () =>
      Promise.resolve({ status: 'up', detail: {} }),
    );
    expect(result).toEqual({ name: 'x', status: 'up', detail: {} });
  });

  it('reports a rejection with the failure status it was given', async () => {
    const result = await boundedCheck('x', 'degraded', () => Promise.reject(new Error('refused')));
    expect(result).toEqual({ name: 'x', status: 'degraded', detail: { error: 'refused' } });
  });

  it('reports a hang as a timeout rather than hanging the probe', async () => {
    const result = await boundedCheck('x', 'down', () => new Promise(() => undefined), 20);
    expect(result.status).toBe('down');
    expect(result.detail.error).toContain('timed out');
  });
});

describe('checkReplicationSlot', () => {
  const slot = (row: object) => dataSourceAnswering({ pg_replication_slots: [row] });

  it('is up when active, confirmed and close behind', async () => {
    const result = await checkReplicationSlot(
      slot({ active: true, unconfirmed: false, lag: '4096' }),
      'arthome_identity_outbox',
    );
    expect(result.status).toBe('up');
  });

  it.each([
    ['inactive', { active: false, unconfirmed: false, lag: '0' }],
    ['unconfirmed', { active: true, unconfirmed: true, lag: null }],
    ['past §7.4’s gigabyte', { active: true, unconfirmed: false, lag: String(2 ** 30 + 1) }],
  ])('is degraded, never down, when %s', async (_, row) => {
    const result = await checkReplicationSlot(slot(row), 'arthome_identity_outbox');
    expect(result.status).toBe('degraded');
  });

  it('is degraded when no slot exists', async () => {
    const result = await checkReplicationSlot(dataSourceAnswering({}), 'arthome_catalog_outbox');
    expect(result).toMatchObject({ status: 'degraded', detail: { present: false } });
  });
});

describe('checkPublicationScope', () => {
  it('is up when scoped to outbox_event alone', async () => {
    const ds = dataSourceAnswering({
      'FROM pg_publication WHERE': [{ puballtables: false }],
      pg_publication_tables: [{ name: 'public.outbox_event' }],
    });
    expect((await checkPublicationScope(ds, 'arthome_identity_outbox')).status).toBe('up');
  });

  /** The state found live on 2026-09-26. */
  it('is degraded when created FOR ALL TABLES', async () => {
    const ds = dataSourceAnswering({
      'FROM pg_publication WHERE': [{ puballtables: true }],
      pg_publication_tables: [
        { name: 'public.migrations' },
        { name: 'public.account' },
        { name: 'public.outbox_event' },
      ],
    });
    const result = await checkPublicationScope(ds, 'arthome_identity_outbox');
    expect(result).toMatchObject({ status: 'degraded', detail: { allTables: true } });
  });
});

describe('checkOutboxRetention', () => {
  it('is up when nothing is past the retention', async () => {
    const ds = dataSourceAnswering({ outbox_event: [{ past: 0 }] });
    expect((await checkOutboxRetention(ds)).status).toBe('up');
  });

  it('is degraded when rows outlived it, because the purge is not running or is refusing', async () => {
    const ds = dataSourceAnswering({ outbox_event: [{ past: 3 }] });
    expect(await checkOutboxRetention(ds)).toMatchObject({
      status: 'degraded',
      detail: { rowsPastRetention: 3 },
    });
  });
});

describe('checkDeadLetterDepth', () => {
  const admin = (offsets: object[]) =>
    ({ fetchTopicOffsets: () => Promise.resolve(offsets) }) as unknown as Admin;

  it('counts high minus low across partitions', async () => {
    const result = await checkDeadLetterDepth(
      admin([
        { partition: 0, high: '5', low: '4' },
        { partition: 1, high: '2', low: '2' },
      ]),
      'arthome.notifications.dlq',
    );
    expect(result).toMatchObject({ status: 'degraded', detail: { depth: 1 } });
  });

  it('is up when empty', async () => {
    const result = await checkDeadLetterDepth(admin([{ partition: 0, high: '3', low: '3' }]), 'x');
    expect(result.status).toBe('up');
  });
});
