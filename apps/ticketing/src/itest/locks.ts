import { setTimeout as delay } from 'node:timers/promises';

import type { DataSource } from 'typeorm';

/**
 * Causal stand-ins for wall-clock bounds: a statement held open on an advisory lock the suite
 *   holds, seen waiting in `pg_stat_activity`, and work that must finish without ever waiting on a
 *   row lock. Neither depends on how loaded the machine is.
 */

const POLL_MS = 10;
const SEEN_WAITING_WITHIN_MS = 30_000;

/** Takes the session advisory lock `key` on a connection of its own; the answer releases it. */
export async function holdAdvisoryLock(
  dataSource: DataSource,
  key: number,
): Promise<() => Promise<void>> {
  const holder = dataSource.createQueryRunner();
  await holder.connect();
  await holder.query('SELECT pg_advisory_lock($1)', [key]);
  return async () => {
    try {
      await holder.query('SELECT pg_advisory_unlock($1)', [key]);
    } finally {
      await holder.release();
    }
  };
}

/**
 * A `BEFORE INSERT` row trigger named `name` on `table` that waits on the advisory lock `key`
 *   while `when` holds of `NEW`: the transaction inserting stays open, its row unwritten, until
 *   the suite releases the lock. The answer drops the trigger and its function.
 */
export async function gateInserts(
  dataSource: DataSource,
  { name, table, when, key }: { name: string; table: string; when: string; key: number },
): Promise<() => Promise<void>> {
  await dataSource.query(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS
       $$ BEGIN PERFORM pg_advisory_xact_lock_shared(${String(key)}); RETURN NEW; END $$`,
  );
  await dataSource.query(
    `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW
       WHEN (${when}) EXECUTE FUNCTION ${name}()`,
  );
  return async () => {
    await dataSource.query(`DROP TRIGGER ${name} ON ${table}`);
    await dataSource.query(`DROP FUNCTION ${name}()`);
  };
}

async function backendsWaiting(dataSource: DataSource, onAdvisory: boolean): Promise<number> {
  const [row] = await dataSource.query<{ waiting: number }[]>(
    `SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND (wait_event = 'advisory') = $1`,
    [onAdvisory],
  );
  return row?.waiting ?? 0;
}

/** Resolves once `count` backends of this database wait on an advisory lock. */
export async function untilWaitingOnAdvisoryLock(dataSource: DataSource, count = 1): Promise<void> {
  const deadline = performance.now() + SEEN_WAITING_WITHIN_MS;
  while ((await backendsWaiting(dataSource, true)) < count) {
    if (performance.now() > deadline) {
      throw new Error(`no ${String(count)} backends waiting on an advisory lock`);
    }
    await delay(POLL_MS);
  }
}

/**
 * Settles with `work`, failing as soon as any backend of this database waits on a row lock: the
 *   suite holds the lock until after, so work that waits would wait until then.
 */
export async function withoutRowLockWait<T>(dataSource: DataSource, work: Promise<T>): Promise<T> {
  let done = false;
  const settled = work.finally(() => {
    done = true;
  });
  while (!done) {
    if ((await backendsWaiting(dataSource, false)) > 0) {
      settled.catch(() => undefined);
      throw new Error('waited on a row lock another transaction holds');
    }
    await delay(POLL_MS);
  }
  return settled;
}
