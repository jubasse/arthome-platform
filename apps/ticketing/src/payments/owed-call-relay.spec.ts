import type { Job, JobState } from 'bullmq';
import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';

import { FixedClock } from '@arthome/core';

import {
  OwedCallRelay,
  RELAY_BATCH,
  RERUN_ASKED_REFUNDS_SQL,
  RERUN_BATCH,
  type ProviderCallProducer,
} from './owed-call-relay.js';
import { jobIdOf } from './provider-call-queues.js';

interface AskedRow {
  readonly id: string;
  readonly idempotency_key: string;
  readonly owed: boolean;
}

const asked = (id: string, owed = true): AskedRow => ({
  id,
  idempotency_key: `refund:${id}`,
  owed,
});

/** A job in `state`, each Redis call taking a tick, and the most lookups seen in flight at once. */
function queueOf(states: ReadonlyMap<string, JobState | undefined>) {
  let inFlight = 0;
  const seen = {
    mostInFlight: 0,
    getState: 0,
    isActive: 0,
    isDelayed: 0,
    promoted: [] as string[],
  };
  const tick = async <T>(value: T): Promise<T> => {
    inFlight += 1;
    seen.mostInFlight = Math.max(seen.mostInFlight, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    return value;
  };
  const getJob = vi.fn((jobId: string) => {
    const state = states.get(jobId);
    if (state === undefined) return tick(undefined);
    const job = {
      getState: () => {
        seen.getState += 1;
        return tick(state);
      },
      isActive: () => {
        seen.isActive += 1;
        return tick(state === 'active');
      },
      isDelayed: () => {
        seen.isDelayed += 1;
        return tick(state === 'delayed');
      },
      promote: () => {
        seen.promoted.push(jobId);
        return tick(undefined);
      },
    };
    return tick(job as unknown as Job);
  });
  return { getJob, seen };
}

/** A pass where only the webhook's reruns are due: `rows` claimed, the cleared ids recorded. */
function relayOver(rows: readonly AskedRow[], states: ReadonlyMap<string, JobState | undefined>) {
  const cleared: string[][] = [];
  const claimedWith: unknown[][] = [];
  const manager = {
    query: (sql: string, parameters: unknown[]) => {
      if (sql === RERUN_ASKED_REFUNDS_SQL) {
        claimedWith.push(parameters);
        return Promise.resolve(rows);
      }
      if (sql.includes('SET rerun_asked_at = NULL')) cleared.push(parameters[0] as string[]);
      return Promise.resolve([]);
    },
  } as unknown as EntityManager;
  const dataSource = {
    query: () => Promise.resolve([[], 0]),
    transaction: (work: (manager: EntityManager) => Promise<unknown>) => work(manager),
  } as unknown as DataSource;
  const queue = queueOf(states);
  const producer = {
    ready: () => Promise.resolve(),
    refunds: { getJob: queue.getJob },
    intentCancellations: {},
  } as unknown as ProviderCallProducer;
  const relay = new OwedCallRelay(dataSource, producer, new FixedClock('2026-10-10T10:00:00Z'), {
    refunds: [100],
    intentCancellations: [100],
  });
  return { relay, cleared, claimedWith, queue };
}

describe("the refund webhook's reruns (R15, replaced)", () => {
  it(`claims at most ${String(RERUN_BATCH)} rows, well under the relay's batch`, async () => {
    const { relay, claimedWith } = relayOver([], new Map());

    await relay.relayDue();

    expect(claimedWith).toEqual([[RERUN_BATCH]]);
    expect(RERUN_BATCH).toBeLessThan(RELAY_BATCH);
  });

  it('reads each job once, keeps a running one asked, promotes a delayed one, answers the rest', async () => {
    const rows = [
      asked('active'),
      asked('delayed'),
      asked('waiting'),
      asked('completed'),
      asked('lost'),
      asked('made', false),
    ];
    const states = new Map<string, JobState | undefined>([
      [jobIdOf('refund:active'), 'active'],
      [jobIdOf('refund:delayed'), 'delayed'],
      [jobIdOf('refund:waiting'), 'waiting'],
      [jobIdOf('refund:completed'), 'completed'],
    ]);
    const { relay, cleared, queue } = relayOver(rows, states);

    await relay.relayDue();

    expect(queue.getJob).toHaveBeenCalledTimes(5);
    expect(queue.getJob).not.toHaveBeenCalledWith(jobIdOf('refund:made'));
    expect(queue.seen).toMatchObject({ getState: 4, isActive: 0, isDelayed: 0 });
    expect(queue.seen.promoted).toEqual([jobIdOf('refund:delayed')]);
    expect(cleared).toEqual([['delayed', 'waiting', 'completed', 'lost', 'made']]);
  });

  it('looks the jobs up in parallel, not one round trip after another', async () => {
    const rows = Array.from({ length: 10 }, (_, index) => asked(`refund-${String(index)}`));
    const states = new Map(
      rows.map(({ idempotency_key }) => [jobIdOf(idempotency_key), 'delayed' as const]),
    );
    const { relay, queue } = relayOver(rows, states);

    await relay.relayDue();

    expect(queue.seen.mostInFlight).toBe(rows.length);
    expect(queue.seen.promoted).toHaveLength(rows.length);
  });

  it('counts a full rerun batch as a full pass, so the next one runs at once', async () => {
    const rows = Array.from({ length: RERUN_BATCH }, (_, index) =>
      asked(`refund-${String(index)}`),
    );
    const { relay } = relayOver(rows, new Map());

    expect(await relay.relayDue()).toBe(RELAY_BATCH);
  });
});
