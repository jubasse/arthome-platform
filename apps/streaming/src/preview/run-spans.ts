import type { EntityManager } from 'typeorm';

import { isPreviewBudgetSpending, type Instant, type Window } from '@arthome/core';

import { onAirIntervalsOf, type Veil } from './on-air-intervals.js';
import { readRunFacts } from '../run/run-facts.js';

/** Where a date's run stands for the budget: whether it is spending now, and the spans it spent on. */
export interface RunSpans {
  readonly spending: boolean;
  readonly onAir: Window[];
}

interface VeilRow {
  readonly raised_at: Date;
  readonly resolved_at: Date | null;
}

export const VEILS_SQL = `SELECT incident.raised_at, incident.resolved_at
       FROM incident JOIN run ON run.id = incident.run_id
      WHERE run.date_id = $1`;

/** On the caller's manager, no lock: a date without a run, or not yet on air, spends nothing. */
export async function readRunSpans(
  manager: EntityManager,
  dateId: string,
  now: Instant,
): Promise<RunSpans> {
  const run = await readRunFacts(manager, dateId);
  if (run?.startedAt == null) return { spending: false, onAir: [] };
  const rows = await manager.query<VeilRow[]>(VEILS_SQL, [dateId]);
  const veils: Veil[] = rows.map((row) => ({
    raisedAt: row.raised_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  }));
  return {
    spending: isPreviewBudgetSpending(run.state),
    onAir: onAirIntervalsOf({ startedAt: run.startedAt, endedAt: run.endedAt, veils }, now),
  };
}
