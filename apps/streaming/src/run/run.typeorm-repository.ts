import {
  AggregateTracker,
  saveVersioned,
  updateReturning,
  type Track,
} from '@arthome-platform/transactions';
import { IsNull, type EntityManager } from 'typeorm';

import { DomainError, DomainErrorCode, type Instant, type RunState } from '@arthome/core';

import type { IncidentSnapshot } from './incident.js';
import { Run, type RunSnapshot } from './run.aggregate.js';
import { IncidentRow, RunRow } from './run.entity.js';
import { RunRepository } from './run.repository.js';

/** What a versioned save writes; presence and `after_grace_period` move by statements of their own. */
interface StateColumns {
  readonly state: RunState;
  readonly technical_check_passed_at: Date | null;
  readonly started_at: Date | null;
  readonly ended_at: Date | null;
  readonly version: number;
}

interface Loaded {
  readonly incidentId: string | null;
  readonly afterGracePeriod: boolean;
}

export class TypeOrmRunRepository extends RunRepository {
  private readonly tracker: AggregateTracker<Run>;
  private readonly loaded = new WeakMap<Run, Loaded>();

  public constructor(
    private readonly manager: EntityManager,
    track: Track,
  ) {
    super();
    this.tracker = new AggregateTracker(track);
  }

  public async findByDate(dateId: string): Promise<Run | null> {
    const row = await this.manager.findOne(RunRow, {
      where: { date_id: dateId },
      lock: { mode: 'pessimistic_write' },
    });
    return row === null ? null : this.restored(row);
  }

  public async findById(runId: string): Promise<Run | null> {
    const row = await this.manager.findOne(RunRow, {
      where: { id: runId },
      lock: { mode: 'pessimistic_write' },
    });
    return row === null ? null : this.restored(row);
  }

  public async findByStreamPath(streamPath: string): Promise<Run | null> {
    const row = await this.manager.findOne(RunRow, {
      where: { stream_path: streamPath },
      lock: { mode: 'pessimistic_write' },
    });
    return row === null ? null : this.restored(row);
  }

  public async claim(runId: string): Promise<Run | null> {
    const row = await this.manager.findOne(RunRow, {
      where: { id: runId },
      lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' },
    });
    return row === null ? null : this.restored(row);
  }

  public async add(run: Run): Promise<boolean> {
    const current = run.snapshot;
    const inserted = await this.manager.query<{ id: string }[]>(
      `INSERT INTO run (id, date_id, channel_id, state, stream_path, ingest_protocol, monitor_path,
                        after_grace_period, version)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (date_id) DO NOTHING
       RETURNING id`,
      [
        current.runId,
        current.dateId,
        current.channelId,
        current.state,
        current.streamPath,
        current.ingestProtocol,
        current.monitorPath,
        current.afterGracePeriod,
        current.version,
      ],
    );
    if (inserted.length === 0) return false;
    this.loaded.set(run, { incidentId: null, afterGracePeriod: current.afterGracePeriod });
    this.tracker.written(run, current.version);
    return true;
  }

  public async save(run: Run): Promise<void> {
    const current = run.snapshot;
    const loadedVersion = this.tracker.versionOf(run);
    const loaded = this.loaded.get(run);
    if (loadedVersion === undefined || loaded === undefined) {
      throw new Error('a run is saved by the transaction that loaded or added it');
    }
    if (current.incident !== null) {
      await this.writeIncident(current, current.incident, loaded, loadedVersion);
    }
    if (current.version !== loadedVersion) {
      await saveVersioned(
        this.manager,
        RunRow,
        { id: current.runId },
        loadedVersion,
        stateColumnsOf(current),
        ({ version, state }) => ({ currentVersion: version, state }),
      );
    }
    if (current.afterGracePeriod !== loaded.afterGracePeriod) {
      await updateReturning(
        this.manager,
        'UPDATE run SET after_grace_period = $2 WHERE id = $1 RETURNING id',
        [current.runId, current.afterGracePeriod],
      );
    }
    this.loaded.set(run, {
      incidentId: current.incident?.id ?? null,
      afterGracePeriod: current.afterGracePeriod,
    });
    this.tracker.written(run, current.version);
  }

  private async restored(row: RunRow): Promise<Run> {
    // Locked after its run, never before: the order every transaction here takes them in.
    const incident = await this.manager.findOne(IncidentRow, {
      where: { run_id: row.id, resolved_at: IsNull() },
      lock: { mode: 'pessimistic_write' },
    });
    const run = Run.restore(runSnapshotOf(row, incident));
    this.loaded.set(run, {
      incidentId: incident?.id ?? null,
      afterGracePeriod: row.after_grace_period,
    });
    return this.tracker.loaded(run, row.version);
  }

  /** A new incident is inserted, or the loaded one resolved; a reused id inserts nothing. */
  private async writeIncident(
    run: RunSnapshot,
    incident: IncidentSnapshot,
    loaded: Loaded,
    loadedVersion: number,
  ): Promise<void> {
    if (incident.id === loaded.incidentId) {
      if (incident.resolvedAt === null) return;
      await updateReturning(
        this.manager,
        `UPDATE incident SET resolved_at = $2, resolved_by = $3
          WHERE id = $1 AND resolved_at IS NULL
         RETURNING id`,
        [incident.id, new Date(incident.resolvedAt), incident.resolvedBy],
      );
      return;
    }
    const inserted = await this.manager.query<{ id: string }[]>(
      `INSERT INTO incident (id, run_id, date_id, kind, cause, trigger, message_language,
                             message_text, raised_at, raised_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        incident.id,
        run.runId,
        run.dateId,
        incident.kind,
        incident.cause,
        incident.trigger,
        incident.message?.contentLanguage ?? null,
        incident.message?.text ?? null,
        new Date(incident.raisedAt),
        incident.raisedBy,
      ],
    );
    if (inserted.length === 0) {
      throw new DomainError({
        code: DomainErrorCode.STATE_CONFLICT,
        params: { currentVersion: loadedVersion },
      });
    }
  }
}

export function instantOf(value: Date): Instant;
export function instantOf(value: Date | null): Instant | null;
export function instantOf(value: Date | null): Instant | null {
  return value === null ? null : value.toISOString();
}

function dateOf(instant: Instant | null): Date | null {
  return instant === null ? null : new Date(instant);
}

export function incidentSnapshotOf(row: IncidentRow): IncidentSnapshot {
  return {
    id: row.id,
    kind: row.kind,
    cause: row.cause,
    trigger: row.trigger,
    message:
      row.message_language === null || row.message_text === null
        ? null
        : { contentLanguage: row.message_language, text: row.message_text },
    raisedAt: instantOf(row.raised_at),
    raisedBy: row.raised_by,
    resolvedAt: instantOf(row.resolved_at),
    resolvedBy: row.resolved_by,
  };
}

export function runSnapshotOf(row: RunRow, incident: IncidentRow | null): RunSnapshot {
  return {
    runId: row.id,
    dateId: row.date_id,
    channelId: row.channel_id,
    state: row.state,
    streamPath: row.stream_path,
    ingestProtocol: row.ingest_protocol,
    monitorPath: row.monitor_path,
    technicalCheckPassedAt: instantOf(row.technical_check_passed_at),
    startedAt: instantOf(row.started_at),
    endedAt: instantOf(row.ended_at),
    publisherOnlineSince: instantOf(row.publisher_online_since),
    publisherLostAt: instantOf(row.publisher_lost_at),
    afterGracePeriod: row.after_grace_period,
    incident: incident === null ? null : incidentSnapshotOf(incident),
    version: row.version,
  };
}

function stateColumnsOf(run: RunSnapshot): StateColumns {
  return {
    state: run.state,
    technical_check_passed_at: dateOf(run.technicalCheckPassedAt),
    started_at: dateOf(run.startedAt),
    ended_at: dateOf(run.endedAt),
    version: run.version,
  };
}
