import { Outcome, claimMessage } from '@arthome-platform/messaging';
import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import type { Clock } from '@arthome/core';

import { reportStaleness } from './freshness.js';
import { RecordSubscriptionFact } from './record-subscription-fact.command.js';
import { CLOCK } from '../clock.js';
import { StreamingTransactions } from '../streaming-transactions.js';

/**
 * Ticketing's version decides when both facts carry one, an equal one being a redelivery;
 *   otherwise the instant does. The kept instant never goes back, so a higher version stated
 *   earlier leaves a later unversioned fact compared with the latest instant seen.
 */
export const RECORD_SUBSCRIPTION = `
  INSERT INTO entitlement_subscription AS kept
              (account_id, plan, state, openings, paid_through, version, occurred_at, applied_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (account_id) DO UPDATE
          SET plan = excluded.plan, state = excluded.state, openings = excluded.openings,
              paid_through = excluded.paid_through,
              version = COALESCE(excluded.version, kept.version),
              occurred_at = GREATEST(excluded.occurred_at, kept.occurred_at),
              applied_at = excluded.applied_at
        WHERE CASE
                WHEN excluded.version IS NOT NULL AND kept.version IS NOT NULL
                  THEN excluded.version > kept.version
                ELSE excluded.occurred_at >= kept.occurred_at
              END
    RETURNING account_id`;

@CommandHandler(RecordSubscriptionFact)
export class RecordSubscriptionFactHandler implements ICommandHandler<RecordSubscriptionFact> {
  private readonly logger = new Logger(RecordSubscriptionFactHandler.name);

  public constructor(
    private readonly transactions: StreamingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute({ delivery, fact }: RecordSubscriptionFact): Promise<Outcome> {
    const appliedAtMs = this.clock.nowMs();
    const outcome = await this.transactions.run(async ({ manager }) => {
      if (!(await claimMessage(manager, delivery.messageId, delivery.topic))) {
        return Outcome.DUPLICATE;
      }
      const written = await manager.query<unknown[]>(RECORD_SUBSCRIPTION, [
        fact.accountId,
        fact.plan,
        fact.state,
        fact.openings,
        fact.paidThrough,
        fact.version?.toString() ?? null,
        fact.statedAt,
        new Date(appliedAtMs),
      ]);
      return written.length === 1 ? Outcome.APPLIED : Outcome.SUPERSEDED;
    });
    if (outcome === Outcome.APPLIED) {
      reportStaleness(this.logger, fact, `account=${fact.accountId}`, appliedAtMs);
    }
    return outcome;
  }
}
