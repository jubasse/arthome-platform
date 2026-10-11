import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';

import { runConsoleOf, type RunConsole } from './run-console.js';
import { sampleWithin } from './run-desk-call.js';
import { IncidentRow, RunRow } from './run.entity.js';
import { incidentSnapshotOf, runSnapshotOf } from './run.typeorm-repository.js';
import type { LiveIngestProvider, StreamingMetricsProvider } from '../media/media-ports.js';
import { LIVE_INGEST_PROVIDER, STREAMING_METRICS_PROVIDER } from '../media/media-tokens.js';

/** The console as committed, without a lock: a read never waits for a command. */
@Injectable()
export class RunConsoleReader {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(LIVE_INGEST_PROVIDER) private readonly ingest: LiveIngestProvider,
    @Inject(STREAMING_METRICS_PROVIDER) private readonly metrics: StreamingMetricsProvider,
  ) {}

  public async consoleOf(dateId: string, remainingMs: number): Promise<RunConsole | null> {
    const [row, incident] = await this.dataSource.transaction(
      'REPEATABLE READ',
      async (manager) => {
        const run = await manager.findOneBy(RunRow, { date_id: dateId });
        return [
          run,
          run === null
            ? null
            : await manager.findOneBy(IncidentRow, { run_id: run.id, resolved_at: IsNull() }),
        ] as const;
      },
    );
    if (row === null) return null;
    const run = runSnapshotOf(row, incident);
    const sample = await sampleWithin(remainingMs, this.metrics, run.streamPath);
    return runConsoleOf(
      run,
      incident === null ? null : incidentSnapshotOf(incident),
      this.ingest,
      sample,
    );
  }
}
