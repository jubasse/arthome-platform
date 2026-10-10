import { AggregateTracker, type Track } from '@arthome-platform/transactions';
import type { EntityManager } from 'typeorm';

import type { Credit } from './credit.aggregate.js';
import { CreditRow } from './credit.entity.js';
import { CreditRepository } from './credit.repository.js';

export class TypeOrmCreditRepository extends CreditRepository {
  private readonly tracker: AggregateTracker<Credit>;

  public constructor(
    private readonly manager: EntityManager,
    track: Track,
  ) {
    super();
    this.tracker = new AggregateTracker(track);
  }

  /** `ON CONFLICT DO NOTHING`, never a 23505 that would abort the settlement's batch. */
  public async issue(credit: Credit): Promise<boolean> {
    const current = credit.snapshot;
    const inserted = await this.manager
      .createQueryBuilder()
      .insert()
      .into(CreditRow)
      .values({
        id: current.id,
        account_id: current.accountId,
        channel_id: current.channelId,
        order_id: current.orderId,
        amount_minor: String(current.amount.amountMinor),
        currency_code: current.amount.currencyCode,
        origin: current.origin,
        origin_ref: current.originRef,
        state: current.state,
        expires_at: new Date(current.expiresAt),
        version: current.version,
      })
      .orIgnore()
      .returning('id')
      .execute();
    if ((inserted.raw as unknown[]).length === 0) return false;
    this.tracker.written(credit, current.version);
    return true;
  }
}
