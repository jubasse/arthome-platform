import { frozen } from '@arthome-platform/transactions';
import { AggregateRoot } from '@nestjs/cqrs';

import {
  CreditState,
  creditExpiresAt,
  type CreditOrigin,
  type Instant,
  type Money,
} from '@arthome/core';

import { CreditIssued, type CreditEvent } from './credit.events.js';

/** A credit its caller decided: for whom, on which channel (D-017), how much, and why. */
export interface CreditIssue {
  readonly id: string;
  readonly accountId: string;
  readonly channelId: string;
  readonly orderId: string;
  readonly amount: Money;
  readonly origin: CreditOrigin;
  /** What it was issued for: the interrupted date. */
  readonly originRef: string | null;
}

export interface CreditSnapshot extends CreditIssue {
  readonly state: CreditState;
  readonly expiresAt: Instant;
  readonly version: number;
}

/**
 * data-model.md §3.7's credit note: money the platform owes on an account, spendable on the
 *   issuing channel alone until it expires. Redeeming it is D-098's, not this slice's.
 */
export class Credit extends AggregateRoot<CreditEvent> {
  private current: CreditSnapshot;

  private constructor(current: CreditSnapshot) {
    super();
    this.current = frozen(current);
  }

  /** Valid `CREDIT_VALIDITY_MONTHS` from `now`; a credit of nothing is refused. */
  public static issue(issue: CreditIssue, now: Instant): Credit {
    if (issue.amount.amountMinor <= 0) {
      throw new Error(`credit ${issue.id} of order ${issue.orderId} would be of nothing`);
    }
    const credit = new Credit({
      ...structuredClone(issue),
      state: CreditState.ISSUED,
      expiresAt: creditExpiresAt(now),
      version: 1,
    });
    credit.apply(new CreditIssued(credit.current, now));
    return credit;
  }

  public get snapshot(): CreditSnapshot {
    return this.current;
  }
}
