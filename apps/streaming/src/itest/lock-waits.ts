import type { DataSource } from 'typeorm';

/**
 * Resolves once a connection to this database waits on a lock, or once `settled` settles, whichever
 *   comes first: a command that does not wait on the lock a test holds shows as settled.
 */
export async function untilBlockedOrSettled(
  dataSource: DataSource,
  settled: Promise<unknown>,
): Promise<void> {
  let done = false;
  const settle = (): void => {
    done = true;
  };
  settled.then(settle, settle);
  while (!done) {
    const [row] = await dataSource.query<{ waiting: number }[]>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((row?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
