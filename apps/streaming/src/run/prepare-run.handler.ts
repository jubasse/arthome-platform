import { randomUUID } from 'node:crypto';

import { Outcome, claimMessage } from '@arthome-platform/messaging';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import type { Clock } from '@arthome/core';

import { PrepareRun } from './prepare-run.command.js';
import { recordRunEvents } from './record-run-events.js';
import { Run } from './run.aggregate.js';
import {
  FIRST_STREAM_KEY_GENERATION,
  STREAM_KEY_SECRET,
  insertStreamKey,
  newStreamPath,
} from './stream-key.js';
import { CLOCK } from '../clock.js';
import { StreamingTransactions } from '../streaming-transactions.js';

/**
 * The date's run, prepared when catalog drafts it: idle, on a random stream path, with its first
 *   key generation. The message is claimed in the same transaction; a second draft of the date is
 *   superseded, the first run kept. Reached from Kafka alone, so a refusal is core's
 *   `DomainError`, which the consumer maps (`nestjs-request-pipeline` rule 1).
 */
@CommandHandler(PrepareRun)
export class PrepareRunHandler implements ICommandHandler<PrepareRun> {
  public constructor(
    private readonly transactions: StreamingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STREAM_KEY_SECRET) private readonly streamKeySecret: string,
  ) {}

  public execute({ delivery, fact }: PrepareRun): Promise<Outcome> {
    return this.transactions.run(async ({ manager, runs }) => {
      if (!(await claimMessage(manager, delivery.messageId, delivery.topic))) {
        return Outcome.DUPLICATE;
      }
      const now = this.clock.now();
      const run = Run.prepare(
        {
          runId: randomUUID(),
          dateId: fact.dateId,
          channelId: fact.channelId,
          streamPath: newStreamPath(),
        },
        now,
      );
      if (!(await runs.add(run))) return Outcome.SUPERSEDED;
      const { runId } = run.snapshot;
      await insertStreamKey(manager, this.streamKeySecret, runId, FIRST_STREAM_KEY_GENERATION, now);
      await recordRunEvents(manager, run.getUncommittedEvents(), delivery.traceparent);
      return Outcome.APPLIED;
    });
  }
}
