import { randomUUID } from 'node:crypto';

import {
  IncidentCause,
  IncidentKind,
  IncidentTrigger,
  RunState,
  type Instant,
} from '@arthome/core';

import { setRun, type Playback } from './playback.js';

export interface BudgetRow {
  readonly settled_seconds: number;
  readonly precharged_seconds: number;
  readonly covered_until: Date | null;
}

/** The account's budget row on the date, as the meter keeps it. */
export async function budgetOf(
  playback: Playback,
  accountId: string,
  dateId: string,
): Promise<BudgetRow | undefined> {
  const [row] = await playback.dataSource.query<BudgetRow[]>(
    `SELECT settled_seconds, precharged_seconds, covered_until
       FROM preview_budget WHERE account_id = $1 AND date_id = $2`,
    [accountId, dateId],
  );
  return row;
}

/** The veil as PS1 leaves it: an open incident, the run `interrupted`. */
export async function raiseVeil(playback: Playback, dateId: string): Promise<void> {
  await setRun(playback, dateId, RunState.INTERRUPTED);
  await playback.dataSource.query(
    `INSERT INTO incident (id, run_id, date_id, kind, cause, trigger, raised_at)
          SELECT $1, run.id, run.date_id, $2, $3, $4, $5 FROM run WHERE run.date_id = $6`,
    [
      randomUUID(),
      IncidentKind.HOLD_SCREEN,
      IncidentCause.VENUE_FEED_LOST,
      IncidentTrigger.AUTO,
      playback.clock.now(),
      dateId,
    ],
  );
}

export async function resolveVeil(playback: Playback, dateId: string, at?: Instant): Promise<void> {
  await playback.dataSource.query(
    `UPDATE incident SET resolved_at = $1 WHERE date_id = $2 AND resolved_at IS NULL`,
    [at ?? playback.clock.now(), dateId],
  );
  await setRun(playback, dateId, RunState.ON_AIR);
}
