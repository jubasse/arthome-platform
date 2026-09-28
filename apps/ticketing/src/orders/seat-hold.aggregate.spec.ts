import { describe, expect, it } from 'vitest';

import { DomainError, DomainErrorCode, PriceTier } from '@arthome/core';

import { SeatHoldOrigin, SeatHoldState } from './commerce-vocabulary.js';
import { SeatHold, type SeatHoldPlacement } from './seat-hold.aggregate.js';

const NOW = '2026-09-28T10:00:00.000Z';
const INTENT_EXPIRES_AT = '2026-09-28T10:15:00.000Z';

const PLACEMENT: SeatHoldPlacement = {
  id: '01a0f600-0000-7000-8000-000000000001',
  dateId: '01a0f600-0000-7000-8000-00000000000d',
  accountId: null,
  profileId: null,
  tier: PriceTier.FULL,
  quantity: 2,
  origin: SeatHoldOrigin.CHECKOUT,
  originRef: '01a0f600-0000-7000-8000-00000000000a',
  intentExpiresAt: INTENT_EXPIRES_AT,
};

describe('SeatHold', () => {
  it('expires at its intent’s instant, one value for both', () => {
    const hold = SeatHold.place(PLACEMENT, NOW);

    expect(hold.snapshot).toMatchObject({
      expiresAt: INTENT_EXPIRES_AT,
      state: SeatHoldState.ACTIVE,
      version: 1,
    });
    expect(hold.getUncommittedEvents()).toMatchObject([
      { kind: 'SeatHoldPlaced', quantity: 2, expiresAt: INTENT_EXPIRES_AT },
    ]);
  });

  it('refuses a quantity core’s holdFor refuses', () => {
    let refusal: unknown;
    try {
      SeatHold.place({ ...PLACEMENT, quantity: 0 }, NOW);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(DomainError);
    expect((refusal as DomainError).code).toBe(DomainErrorCode.HOLD_QUANTITY_INVALID);
  });

  it('is consumed or released once, from active only', () => {
    const consumed = SeatHold.place(PLACEMENT, NOW);
    consumed.consume(NOW);
    expect(consumed.snapshot).toMatchObject({ state: SeatHoldState.CONSUMED, version: 2 });
    expect(() => consumed.release(NOW)).toThrow(/consumed, not active/);

    const released = SeatHold.place(PLACEMENT, NOW);
    released.release(NOW);
    expect(released.isActive).toBe(false);
    expect(() => released.consume(NOW)).toThrow(/released, not active/);
  });
});
