import { describe, expect, it } from 'vitest';

import { CreditOrigin, CreditState, money } from '@arthome/core';

import { Credit, type CreditIssue } from './credit.aggregate.js';
import { CreditIssued } from './credit.events.js';

const NOW = '2026-09-29T10:00:00.000Z';

const ISSUE: CreditIssue = {
  id: '01a0f000-0000-7000-8000-000000000001',
  accountId: '01a0f000-0000-7000-8000-0000000000a1',
  channelId: 'channel-credits',
  orderId: '01a0f000-0000-7000-8000-0000000000b1',
  amount: money(4800, 'EUR'),
  origin: CreditOrigin.INTERRUPTED_DATE,
  originRef: '01a0f000-0000-7000-8000-0000000000d1',
};

describe('Credit', () => {
  it('is issued for its amount, valid twelve months, applying CreditIssued', () => {
    const credit = Credit.issue(ISSUE, NOW);

    expect(credit.snapshot).toEqual({
      ...ISSUE,
      state: CreditState.ISSUED,
      expiresAt: '2027-09-29T10:00:00.000Z',
      version: 1,
    });
    expect(credit.getUncommittedEvents()).toEqual([new CreditIssued(credit.snapshot, NOW)]);
  });

  it('issued on 29 February, expires on the last day of the next February', () => {
    const credit = Credit.issue(ISSUE, '2028-02-29T10:00:00.000Z');

    expect(credit.snapshot.expiresAt).toBe('2029-02-28T10:00:00.000Z');
  });

  it('refuses a credit of nothing', () => {
    expect(() => Credit.issue({ ...ISSUE, amount: money(0, 'EUR') }, NOW)).toThrow(/of nothing/);
  });
});
