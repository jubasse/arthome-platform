import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { RunState } from '@arthome/core';

import { digestsMatch, streamKeyDigestOf } from './stream-key.js';
import type { IngestAttempt, IngestAuthorizer, IngestDecision } from '../media/media-ports.js';

interface IngestTarget {
  readonly id: string;
  readonly state: RunState;
  readonly publisher_online: boolean;
  readonly digest: string | null;
}

export const IngestRefusal = {
  UNKNOWN_PATH: 'no run has this stream path',
  KEY_NOT_CURRENT: "the key is not the run's current generation",
  RUN_ENDED: 'the run has ended',
  PUBLISHER_ONLINE: 'a publisher is online on the run',
} as const;

/**
 * The provider's synchronous question before it accepts a feed (`adr-stream-entitlement.md` §6).
 *   Read only, one statement. A refusal is logged with its reason and the run, never the key nor
 *   anything derived from it.
 */
@Injectable()
export class RunIngestAuthorizer implements IngestAuthorizer {
  private readonly logger = new Logger(RunIngestAuthorizer.name);

  public constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  public async authorize({ streamPath, presentedKey }: IngestAttempt): Promise<IngestDecision> {
    const [target] = await this.dataSource.query<IngestTarget[]>(
      `SELECT run.id, run.state, run.publisher_online_since IS NOT NULL AS publisher_online,
              stream_key.digest
         FROM run
         LEFT JOIN stream_key ON stream_key.run_id = run.id AND stream_key.retired_at IS NULL
        WHERE run.stream_path = $1`,
      [streamPath],
    );
    if (target === undefined) return this.refused(IngestRefusal.UNKNOWN_PATH, null);
    const presented = streamKeyDigestOf(presentedKey);
    if (target.digest === null || !digestsMatch(presented, target.digest)) {
      return this.refused(IngestRefusal.KEY_NOT_CURRENT, target.id);
    }
    if (target.state === RunState.ENDED) return this.refused(IngestRefusal.RUN_ENDED, target.id);
    if (target.publisher_online) return this.refused(IngestRefusal.PUBLISHER_ONLINE, target.id);
    return { accepted: true };
  }

  private refused(reason: string, runId: string | null): IngestDecision {
    this.logger.warn(`ingest refused${runId === null ? '' : ` on run ${runId}`}: ${reason}`);
    return { accepted: false, reason };
  }
}
