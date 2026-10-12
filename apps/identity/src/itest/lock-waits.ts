import { setTimeout as delay } from 'node:timers/promises';

import type { DataSource } from 'typeorm';

const POLL_MS = 10;
const SEEN_WAITING_WITHIN_MS = 30_000;

/**
 * Resolves once a backend of this database runs a statement containing `statement` and waits on a
 *   lock: the race a test drives is then in place, whatever the machine's load.
 */
export async function untilWaitingOnLock(dataSource: DataSource, statement: string): Promise<void> {
  const deadline = performance.now() + SEEN_WAITING_WITHIN_MS;
  for (;;) {
    const [row] = await dataSource.query<{ waiting: number }[]>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND strpos(query, $1) > 0`,
      [statement],
    );
    if ((row?.waiting ?? 0) > 0) return;
    if (performance.now() > deadline) throw new Error(`no backend waits on a lock in ${statement}`);
    await delay(POLL_MS);
  }
}
