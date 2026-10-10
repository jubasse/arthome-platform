import type { EntityManager } from 'typeorm';

import type { Instant, Window } from '@arthome/core';

import { onAirIntervalsOf, type Veil } from './on-air-intervals.js';
import { readRunFacts } from '../run/run-facts.js';

/** The spans of a date's run the budget is spent on. */
export interface RunSpans {
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
  if (run?.startedAt == null) return { onAir: [] };
  const rows = await manager.query<VeilRow[]>(VEILS_SQL, [dateId]);
  const veils: Veil[] = rows.map((row) => ({
    raisedAt: row.raised_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  }));
  return {
    onAir: onAirIntervalsOf({ startedAt: run.startedAt, endedAt: run.endedAt, veils }, now),
  };
}
