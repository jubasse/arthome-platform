import { Outcome, claimMessage } from '@arthome-platform/messaging';
import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import type { EntityManager } from 'typeorm';

import type { Clock } from '@arthome/core';

import { reportStaleness } from './freshness.js';
import {
  RecordDateFact,
  type DateFact,
  type ReplayFacts,
  type RightsFacts,
} from './record-date-fact.command.js';
import { assertNever } from '../assert-never.js';
import { CLOCK } from '../clock.js';
import { StreamingTransactions } from '../streaming-transactions.js';

const newerOrSame = (instant: string): string =>
  `kept.${instant} IS NULL OR excluded.${instant} >= kept.${instant}`;

/** One group of `entitlement_date`, written only when its guard holds: no row back is superseded. */
function groupUpsert(columns: readonly string[], guard: string): string {
  return `
  INSERT INTO entitlement_date AS kept (date_id, applied_at, ${columns.join(', ')})
       VALUES ($1, $2, ${columns.map((_, index) => `$${String(index + 3)}`).join(', ')})
  ON CONFLICT (date_id) DO UPDATE
          SET applied_at = excluded.applied_at,
              ${columns.map((column) => `${column} = excluded.${column}`).join(', ')}
        WHERE ${guard}
    RETURNING date_id`;
}

/**
 * The schedule's start yields to a newer reschedule, but its runtime, which only the schedule
 *   states, is taken whenever none is kept: a reschedule applied first leaves `timing` waiting for it.
 */
export const SCHEDULE_TIMING = `
  INSERT INTO entitlement_date AS kept
              (date_id, applied_at, channel_id, starts_at, runtime_min, timing_occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (date_id) DO UPDATE
          SET applied_at = excluded.applied_at,
              channel_id = excluded.channel_id,
              starts_at = CASE WHEN ${newerOrSame('timing_occurred_at')}
                               THEN excluded.starts_at ELSE kept.starts_at END,
              runtime_min = excluded.runtime_min,
              timing_occurred_at = GREATEST(kept.timing_occurred_at, excluded.timing_occurred_at)
        WHERE kept.runtime_min IS NULL OR ${newerOrSame('timing_occurred_at')}
    RETURNING date_id`;

export const RESCHEDULE_TIMING = groupUpsert(
  ['starts_at', 'timing_occurred_at'],
  newerOrSame('timing_occurred_at'),
);

export const SET_REPLAY = groupUpsert(
  ['replay_policy', 'replay_window_hours', 'replay_occurred_at'],
  newerOrSame('replay_occurred_at'),
);

export const SET_RIGHTS = groupUpsert(
  ['rights_scope', 'blackout_countries', 'blackout_reason', 'rights_occurred_at'],
  newerOrSame('rights_occurred_at'),
);

export const SET_PUBLICATION = groupUpsert(
  ['channel_id', 'publication_state', 'publication_version'],
  'kept.publication_version IS NULL OR excluded.publication_version > kept.publication_version',
);

export const DECLARE_OUTCOME = groupUpsert(
  ['channel_id', 'outcome', 'outcome_declared_at'],
  newerOrSame('outcome_declared_at'),
);

type Write = (statement: string, values: readonly unknown[]) => Promise<boolean>;

const replayValues = (replay: ReplayFacts, statedAt: Date): unknown[] => [
  replay.policy,
  replay.windowHours,
  statedAt,
];

const rightsValues = (rights: RightsFacts, statedAt: Date): unknown[] => [
  rights.scope,
  rights.blackoutCountries,
  rights.reason,
  statedAt,
];

/** `date.scheduled` writes its three groups in one transaction, applied when any one is. */
async function applied(write: Write, fact: DateFact): Promise<boolean> {
  switch (fact.type) {
    case 'catalog.date.scheduled.v1': {
      const timing = await write(SCHEDULE_TIMING, [
        fact.channelId,
        fact.startsAt,
        fact.runtimeMin,
        fact.statedAt,
      ]);
      const replay = await write(SET_REPLAY, replayValues(fact.replay, fact.statedAt));
      const rights = await write(SET_RIGHTS, rightsValues(fact.rights, fact.statedAt));
      return timing || replay || rights;
    }
    case 'catalog.date.rescheduled.v1':
      return write(RESCHEDULE_TIMING, [fact.startsAt, fact.statedAt]);
    case 'catalog.date.replay_policy_set.v1':
      return write(SET_REPLAY, replayValues(fact.replay, fact.statedAt));
    case 'catalog.date.rights_changed.v1':
      return write(SET_RIGHTS, rightsValues(fact.rights, fact.statedAt));
    case 'catalog.publication.state_changed.v1':
      return write(SET_PUBLICATION, [fact.channelId, fact.state, fact.version.toString()]);
    case 'catalog.date.outcome_declared.v1':
      return write(DECLARE_OUTCOME, [fact.channelId, fact.outcome, fact.statedAt]);
    default:
      return assertNever(fact);
  }
}

function writerOn(manager: EntityManager, dateId: string, appliedAt: Date): Write {
  return async (statement, values) => {
    const written = await manager.query<unknown[]>(statement, [dateId, appliedAt, ...values]);
    return written.length === 1;
  };
}

@CommandHandler(RecordDateFact)
export class RecordDateFactHandler implements ICommandHandler<RecordDateFact> {
  private readonly logger = new Logger(RecordDateFactHandler.name);

  public constructor(
    private readonly transactions: StreamingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute({ delivery, fact }: RecordDateFact): Promise<Outcome> {
    const appliedAtMs = this.clock.nowMs();
    const outcome = await this.transactions.run(async ({ manager }) => {
      if (!(await claimMessage(manager, delivery.messageId, delivery.topic))) {
        return Outcome.DUPLICATE;
      }
      const write = writerOn(manager, fact.dateId, new Date(appliedAtMs));
      return (await applied(write, fact)) ? Outcome.APPLIED : Outcome.SUPERSEDED;
    });
    if (outcome === Outcome.APPLIED) {
      reportStaleness(this.logger, fact, `date=${fact.dateId}`, appliedAtMs);
    }
    return outcome;
  }
}
