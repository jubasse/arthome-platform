import type { EntityManager } from 'typeorm';

import type { IncidentKind, Instant, RunState } from '@arthome/core';

import type { IncidentMessage } from './incident.js';

/** The open incident as the storefront's `IncidentSchema` reads it: the veil, not its cause. */
export interface RunIncidentFacts {
  readonly id: string;
  readonly kind: IncidentKind;
  readonly message: IncidentMessage | null;
  readonly raisedAt: Instant;
}

export interface RunFacts {
  readonly state: RunState;
  readonly startedAt: Instant | null;
  readonly endedAt: Instant | null;
  readonly streamPath: string;
  readonly incident: RunIncidentFacts | null;
}

interface RunFactsRow {
  readonly state: RunState;
  readonly started_at: Date | null;
  readonly ended_at: Date | null;
  readonly stream_path: string;
  readonly incident_id: string | null;
  readonly incident_kind: IncidentKind | null;
  readonly message_language: string | null;
  readonly message_text: string | null;
  readonly raised_at: Date | null;
}

/**
 * A date's run for PS3, PS4 and PS5, on the caller's manager and without a lock: one statement,
 *   so the state and the incident are read at one snapshot. Null when the date has no run.
 */
export async function readRunFacts(
  manager: EntityManager,
  dateId: string,
): Promise<RunFacts | null> {
  const [row] = await manager.query<RunFactsRow[]>(
    `SELECT run.state, run.started_at, run.ended_at, run.stream_path,
            incident.id AS incident_id, incident.kind AS incident_kind,
            incident.message_language, incident.message_text, incident.raised_at
       FROM run
       LEFT JOIN incident ON incident.run_id = run.id AND incident.resolved_at IS NULL
      WHERE run.date_id = $1`,
    [dateId],
  );
  if (row === undefined) return null;
  return {
    state: row.state,
    startedAt: row.started_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    streamPath: row.stream_path,
    incident:
      row.incident_id === null || row.incident_kind === null || row.raised_at === null
        ? null
        : {
            id: row.incident_id,
            kind: row.incident_kind,
            message:
              row.message_language === null || row.message_text === null
                ? null
                : { contentLanguage: row.message_language, text: row.message_text },
            raisedAt: row.raised_at.toISOString(),
          },
  };
}
