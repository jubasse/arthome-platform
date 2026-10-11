import { randomUUID } from 'node:crypto';

import { updateReturning } from '@arthome-platform/transactions';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { RunState } from '@arthome/core';

import { RunIngestAuthorizer } from './ingest-authorizer.js';
import { recordRunEvents } from './record-run-events.js';
import {
  IngestProtocol,
  MonitorPath,
  type LiveIngestCapabilities,
  type LiveIngestProvider,
  type IngestLifecycleListener,
  type PublisherOffline,
  type PublisherOnline,
  type WorkerFailed,
} from '../media/media-ports.js';
import { LIVE_INGEST_PROVIDER } from '../media/media-tokens.js';
import { StreamingTransactions } from '../streaming-transactions.js';

/** D-019: the monitor path served is the true one, WHEP only on a WHIP ingest that offers it. */
export function monitorPathOf(
  protocol: IngestProtocol,
  capabilities: LiveIngestCapabilities,
): MonitorPath {
  return protocol === IngestProtocol.WHIP && capabilities.monitorPaths.includes(MonitorPath.WHEP)
    ? MonitorPath.WHEP
    : MonitorPath.LL_HLS;
}

interface BackOnline {
  readonly id: string;
  readonly was_after_grace_period: boolean;
}

/**
 * The provider's reports of a feed's life. Presence moves by conditional statements that leave the
 *   run's version alone, each refusing an instant older than the one recorded, since a report can
 *   arrive late; only lifting the hold screen when the feed returns (D-124) is a state change.
 */
@Injectable()
export class RunIngestListener implements IngestLifecycleListener {
  private readonly logger = new Logger(RunIngestListener.name);

  public constructor(
    private readonly transactions: StreamingTransactions,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(LIVE_INGEST_PROVIDER) private readonly ingest: LiveIngestProvider,
  ) {}

  public publisherOnline({ streamPath, protocol, at }: PublisherOnline): Promise<void> {
    const monitorPath = monitorPathOf(protocol, this.ingest.ingestCapabilities);
    return this.transactions.run(async ({ manager, runs }) => {
      // The run's row locked by the sub-select, first, as every transaction here takes it.
      const [back] = await updateReturning<BackOnline>(
        manager,
        `UPDATE run
            SET publisher_online_since = $2, ingest_protocol = $3, monitor_path = $4,
                after_grace_period = false, updated_at = now()
           FROM (SELECT id, after_grace_period FROM run WHERE stream_path = $1 FOR UPDATE) AS before
          WHERE run.id = before.id AND run.state <> '${RunState.ENDED}'
            AND (run.publisher_lost_at IS NULL OR run.publisher_lost_at <= $2)
         RETURNING run.id, before.after_grace_period AS was_after_grace_period`,
        [streamPath, new Date(at), protocol, monitorPath],
      );
      if (back === undefined) {
        this.logger.warn('a publisher online on no live run, or reported late: nothing recorded');
        return;
      }
      const run = await runs.findById(back.id);
      if (run === null) return;
      run.publisherBack(back.was_after_grace_period, at);
      await runs.save(run);
      await recordRunEvents(manager, run.getUncommittedEvents(), null);
    });
  }

  public async publisherOffline({ streamPath, at }: PublisherOffline): Promise<void> {
    const lost = await updateReturning<{ id: string }>(
      this.dataSource.manager,
      `UPDATE run
          SET publisher_online_since = NULL, publisher_lost_at = $2, updated_at = now()
        WHERE stream_path = $1 AND publisher_online_since IS NOT NULL
          AND publisher_online_since <= $2
       RETURNING id`,
      [streamPath, new Date(at)],
    );
    if (lost.length === 0) {
      this.logger.warn('a publisher offline on a run with none online, or reported late: ignored');
    }
  }

  /** Lifted by the run desk alone: D-124 names the lost feed only. */
  public async workerFailed({ streamPath, final, at }: WorkerFailed): Promise<void> {
    if (!final) return;
    await this.transactions.run(async ({ manager, runs }) => {
      const run = await runs.findByStreamPath(streamPath);
      if (run === null) return;
      if (!run.raiseWorkerFailure(randomUUID(), at)) {
        const { runId, state } = run.snapshot;
        this.logger.warn(
          `run ${runId}: its compatibility worker failed for good, no incident raised (${state}, ` +
            `${run.openIncident === null ? 'none open' : 'one already open'})`,
        );
        return;
      }
      await runs.save(run);
      await recordRunEvents(manager, run.getUncommittedEvents(), null);
    });
  }
}

/** Once, at the API's boot: until then the provider refuses every feed. */
@Injectable()
export class IngestHooksAttachment implements OnApplicationBootstrap {
  public constructor(
    @Inject(LIVE_INGEST_PROVIDER) private readonly ingest: LiveIngestProvider,
    private readonly authorizer: RunIngestAuthorizer,
    private readonly listener: RunIngestListener,
  ) {}

  public onApplicationBootstrap(): void {
    this.ingest.attachIngestHooks({ authorizer: this.authorizer, listener: this.listener });
  }
}
