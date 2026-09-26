import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { findUnpublishedOutboxRows, republishOutboxRow } from './republish.js';

const CREATED_AT = new Date('2026-09-26T08:00:00.000Z');

function row(id: string, aggregatetype = 'catalog.show') {
  return {
    id,
    aggregatetype,
    aggregateid: `agg-${id}`,
    type: `${aggregatetype}.published.v1`,
    created_at: CREATED_AT,
  };
}

function outboxHolding(rows: readonly object[]): { dataSource: DataSource; params: unknown[][] } {
  const params: unknown[][] = [];
  const dataSource = {
    query: (_sql: string, given: unknown[]) => {
      params.push(given);
      return Promise.resolve(rows);
    },
  } as unknown as DataSource;
  return { dataSource, params };
}

describe('findUnpublishedOutboxRows', () => {
  it('reports nothing when every row is on its topic', async () => {
    const { dataSource } = outboxHolding([row('a'), row('b')]);
    const result = await findUnpublishedOutboxRows(dataSource, () =>
      Promise.resolve(new Set(['a', 'b'])),
    );
    expect(result).toEqual({ checked: 2, unpublished: [] });
  });

  it('reports a committed row its topic never carried', async () => {
    const { dataSource } = outboxHolding([row('a'), row('lost')]);
    const result = await findUnpublishedOutboxRows(dataSource, () =>
      Promise.resolve(new Set(['a'])),
    );
    expect(result.unpublished).toEqual([
      {
        id: 'lost',
        aggregateType: 'catalog.show',
        aggregateId: 'agg-lost',
        type: 'catalog.show.published.v1',
        createdAt: CREATED_AT,
      },
    ]);
  });

  it('reads each topic once, from the router’s own naming', async () => {
    const { dataSource } = outboxHolding([
      row('a', 'catalog.show'),
      row('b', 'catalog.show'),
      row('c', 'identity.account'),
    ]);
    const read: string[] = [];
    await findUnpublishedOutboxRows(dataSource, (topic) => {
      read.push(topic);
      return Promise.resolve(new Set(['a', 'b', 'c']));
    });
    expect(read.sort()).toEqual(['arthome.catalog.show', 'arthome.identity.account']);
  });

  /** In flight or past retention, absence from the topic proves nothing. */
  it('queries only the rows between the settle window and the retention horizon', async () => {
    const { dataSource, params } = outboxHolding([]);
    await findUnpublishedOutboxRows(dataSource, () => Promise.resolve(new Set()), {
      settleSeconds: 60,
      horizonHours: 24,
    });
    expect(params[0]).toEqual(['60', '24']);
  });
});

describe('republishOutboxRow', () => {
  function transactional(deletedRows: object[]): { dataSource: DataSource; inserted: unknown[][] } {
    const inserted: unknown[][] = [];
    const manager = {
      query: (sql: string, values: unknown[]) => {
        if (sql.trimStart().startsWith('DELETE'))
          return Promise.resolve([deletedRows, deletedRows.length]);
        inserted.push(values);
        return Promise.resolve([]);
      },
    } as unknown as EntityManager;
    const dataSource = {
      transaction: (run: (m: EntityManager) => Promise<unknown>) => run(manager),
    } as unknown as DataSource;
    return { dataSource, inserted };
  }

  /** The same id is the whole point: it is the message-id every consumer deduplicates on. */
  it('reinserts the row with every value unchanged, its id included', async () => {
    const original = {
      id: 'lost',
      aggregatetype: 'catalog.show',
      aggregateid: 'show-1',
      type: 'catalog.show.published.v1',
      payload: Buffer.from([1, 2, 3]),
      tracecontext: '00-trace-span-01',
      actor_id: null,
      created_at: CREATED_AT,
    };
    const { dataSource, inserted } = transactional([original]);

    expect(await republishOutboxRow(dataSource, 'lost')).toBe(true);
    expect(inserted).toEqual([Object.values(original)]);
  });

  it('answers false and inserts nothing when no row has that id', async () => {
    const { dataSource, inserted } = transactional([]);

    expect(await republishOutboxRow(dataSource, 'absent')).toBe(false);
    expect(inserted).toEqual([]);
  });
});
