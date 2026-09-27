import { describe, expect, it } from 'vitest';

import {
  CatalogErrorCode,
  DateOutcome,
  DomainError,
  DomainErrorCode,
  PriceTier,
  TECHNICAL_PROVISION_THRESHOLD,
  money,
  provisionRevisableUntil,
  type TierPrice,
} from '@arthome/core';

import { DateSales, type DateSalesSnapshot } from './date-sales.aggregate.js';

const DATE_ID = '01a0f000-0000-7000-8000-000000000001';
const CHANNEL_ID = 'channel-sales';
const NOW = '2026-09-27T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
/** When catalog stated a fact, a little before ticketing applies it at `NOW`. */
const STATED_AT = '2026-09-27T09:59:58.000Z';

const FULL: TierPrice = { tier: PriceTier.FULL, amount: money(2400, 'EUR'), active: true };
const REDUCED: TierPrice = { tier: PriceTier.REDUCED, amount: money(1600, 'EUR'), active: true };

function restored(overrides: Partial<DateSalesSnapshot> = {}): DateSales {
  return DateSales.restore({
    dateId: DATE_ID,
    channelId: CHANNEL_ID,
    capacityTotal: 0,
    provisionedCapacity: null,
    capacityTiers: [],
    seatsAvailable: 0,
    seatsSold: 0,
    waitlistCount: 0,
    priceTiers: [],
    pricesLockedAt: null,
    salesClosedAt: null,
    startsAt: null,
    scheduleStatedAt: null,
    outcome: null,
    outcomeStatedAt: null,
    version: 3,
    ...overrides,
  });
}

function refusalOf(decide: () => unknown): DomainError {
  try {
    decide();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('DateSales.open', () => {
  it('opens an empty sale at version 1, before any capacity or price', () => {
    const sales = DateSales.open(DATE_ID, CHANNEL_ID, NOW);

    expect(sales.snapshot).toMatchObject({
      capacityTotal: 0,
      seatsAvailable: 0,
      priceTiers: [],
      pricesLockedAt: null,
      version: 1,
    });
    expect(sales.getUncommittedEvents().map(({ kind }) => kind)).toEqual(['DateSalesOpened']);
  });
});

describe('setPrices', () => {
  it('replaces every tier from the version the screen read, and counts one more change', () => {
    const sales = restored({ priceTiers: [FULL] });

    sales.setPrices(3, [FULL, REDUCED], NOW);

    expect(sales.snapshot.priceTiers).toEqual([FULL, REDUCED]);
    expect(sales.snapshot.version).toBe(4);
    expect(sales.getUncommittedEvents()).toMatchObject([
      { kind: 'DatePricesSet', dateId: DATE_ID, tiers: [FULL, REDUCED], occurredAt: NOW },
    ]);
  });

  it('refuses a stale screen with the current version, before any other rule', () => {
    const sales = restored({ pricesLockedAt: NOW });

    const refusal = refusalOf(() => sales.setPrices(2, [FULL], NOW));

    expect(refusal.code).toBe(DomainErrorCode.STATE_CONFLICT);
    expect(refusal.params).toEqual({ version: 3 });
  });

  it('refuses tiers in two currencies, and changes nothing', () => {
    const sales = restored({ priceTiers: [FULL] });
    const inFrancs: TierPrice = { ...REDUCED, amount: money(1600, 'CHF') };

    const refusal = refusalOf(() => sales.setPrices(3, [FULL, inFrancs], NOW));

    expect(refusal.code).toBe(CatalogErrorCode.PRICES_CURRENCY_MISMATCH);
    expect(refusal.params).toEqual({ tier: PriceTier.REDUCED, currency: 'CHF', expected: 'EUR' });
    expect(sales.snapshot.priceTiers).toEqual([FULL]);
    expect(sales.getUncommittedEvents()).toEqual([]);
  });

  it('refuses once the sale opened, naming when, and changes nothing', () => {
    const sales = restored({ priceTiers: [FULL], pricesLockedAt: '2026-09-26T18:00:00.000Z' });

    const refusal = refusalOf(() => sales.setPrices(3, [REDUCED], NOW));

    expect(refusal.code).toBe(CatalogErrorCode.PRICES_LOCKED);
    expect(refusal.params).toEqual({ lockedAt: '2026-09-26T18:00:00.000Z' });
    expect(sales.snapshot.priceTiers).toEqual([FULL]);
    expect(sales.snapshot.version).toBe(3);
    expect(sales.getUncommittedEvents()).toEqual([]);
  });
});

describe('openCapacityTier', () => {
  it('sets the first capacity, and the seats available with it', () => {
    const sales = restored();

    sales.openCapacityTier(3, 200, NOW);

    expect(sales.snapshot).toMatchObject({
      capacityTotal: 200,
      seatsAvailable: 200,
      capacityTiers: [{ capacity: 200, openedAt: NOW }],
      version: 4,
    });
    expect(sales.getUncommittedEvents()).toMatchObject([
      {
        kind: 'CapacityTierOpened',
        capacityTotal: 200,
        provision: {
          required: false,
          threshold: TECHNICAL_PROVISION_THRESHOLD,
          revisableUntil: null,
        },
      },
    ]);
  });

  it('widens by the tier, keeping the seats a hold or a sale took', () => {
    const sales = restored({
      capacityTotal: 200,
      capacityTiers: [{ id: 'first', capacity: 200, openedAt: '2026-09-20T10:00:00.000Z' }],
      seatsAvailable: 26,
      seatsSold: 170,
    });

    sales.openCapacityTier(3, 50, NOW);

    expect(sales.snapshot.capacityTotal).toBe(250);
    expect(sales.snapshot.seatsAvailable).toBe(76);
    expect(sales.snapshot.capacityTiers.map(({ capacity }) => capacity)).toEqual([200, 50]);
  });

  it('opens up to the threshold with no provision recorded', () => {
    const sales = restored({ capacityTotal: TECHNICAL_PROVISION_THRESHOLD - 1 });

    sales.openCapacityTier(3, 1, NOW);

    expect(sales.snapshot.capacityTotal).toBe(TECHNICAL_PROVISION_THRESHOLD);
  });

  it('refuses a capacity past the threshold no provision covers, naming the deadline', () => {
    const sales = restored({ capacityTotal: TECHNICAL_PROVISION_THRESHOLD, startsAt: STARTS_AT });

    const refusal = refusalOf(() => sales.openCapacityTier(3, 1, NOW));

    expect(refusal.code).toBe(CatalogErrorCode.TECHNICAL_PROVISION_REQUIRED);
    expect(refusal.params).toEqual({
      threshold: TECHNICAL_PROVISION_THRESHOLD,
      capacityTotal: TECHNICAL_PROVISION_THRESHOLD + 1,
      revisableUntil: provisionRevisableUntil(STARTS_AT),
    });
    expect(sales.snapshot.capacityTotal).toBe(TECHNICAL_PROVISION_THRESHOLD);
  });

  it('refuses a tier that does not widen, with the code core gives', () => {
    const refusal = refusalOf(() => restored({ capacityTotal: 200 }).openCapacityTier(3, 0, NOW));

    expect(refusal.code).toBe(DomainErrorCode.CAPACITY_TIER_MUST_WIDEN);
  });

  it('refuses a stale screen', () => {
    expect(refusalOf(() => restored().openCapacityTier(4, 10, NOW)).code).toBe(
      DomainErrorCode.STATE_CONFLICT,
    );
  });

  it('refuses a tier on a sale an outcome closed, naming the outcome', () => {
    const sales = restored({
      capacityTotal: 200,
      outcome: DateOutcome.CANCELLED,
      outcomeStatedAt: STATED_AT,
      salesClosedAt: STATED_AT,
    });

    const refusal = refusalOf(() => sales.openCapacityTier(3, 10, NOW));

    expect(refusal.code).toBe(DomainErrorCode.STATE_CONFLICT);
    expect(refusal.params).toEqual({ version: 3, outcome: DateOutcome.CANCELLED });
    expect(sales.snapshot.capacityTotal).toBe(200);
  });

  it('keeps widening a postponed date, whose sale goes on', () => {
    const sales = restored({ outcome: DateOutcome.POSTPONED, outcomeStatedAt: STATED_AT });

    sales.openCapacityTier(3, 10, NOW);

    expect(sales.snapshot.capacityTotal).toBe(10);
  });
});

describe('setTechnicalProvision', () => {
  it('records the provision, stating it with the capacity and the deadline', () => {
    const sales = restored({ capacityTotal: 8_000, startsAt: STARTS_AT });

    sales.setTechnicalProvision(3, 15_000, NOW);

    expect(sales.snapshot).toMatchObject({ provisionedCapacity: 15_000, version: 4 });
    expect(sales.getUncommittedEvents()).toMatchObject([
      {
        kind: 'TechnicalProvisionSet',
        capacityTotal: 8_000,
        provision: {
          required: false,
          provisionedCapacity: 15_000,
          revisableUntil: provisionRevisableUntil(STARTS_AT),
        },
      },
    ]);
  });

  it('refuses a provision from the revision deadline on, naming it', () => {
    const sales = restored({ startsAt: STARTS_AT });
    const deadline = provisionRevisableUntil(STARTS_AT);

    const refusal = refusalOf(() => sales.setTechnicalProvision(3, 15_000, deadline));

    expect(refusal.code).toBe(CatalogErrorCode.PROVISION_DEADLINE_PASSED);
    expect(refusal.params).toEqual({ revisableUntil: deadline });
    expect(sales.snapshot.provisionedCapacity).toBeNull();
  });

  it('refuses a provision below the capacity already open, naming both', () => {
    const refusal = refusalOf(() =>
      restored({ capacityTotal: 200 }).setTechnicalProvision(3, 150, NOW),
    );

    expect(refusal.code).toBe(CatalogErrorCode.PROVISION_BELOW_CAPACITY);
    expect(refusal.params).toEqual({ capacityTotal: 200, provisionedCapacity: 150 });
  });

  it('refuses a stale screen', () => {
    expect(refusalOf(() => restored().setTechnicalProvision(2, 15_000, NOW)).code).toBe(
      DomainErrorCode.STATE_CONFLICT,
    );
  });
});

describe('a capacity past the threshold', () => {
  it('opens once the recorded provision covers it', () => {
    const sales = restored({
      capacityTotal: TECHNICAL_PROVISION_THRESHOLD,
      provisionedCapacity: 15_000,
      startsAt: STARTS_AT,
    });

    sales.openCapacityTier(3, 2_000, NOW);

    expect(sales.snapshot.capacityTotal).toBe(12_000);
    expect(sales.getUncommittedEvents()).toMatchObject([
      {
        kind: 'CapacityTierOpened',
        provision: {
          required: true,
          provisionedCapacity: 15_000,
          revisableUntil: provisionRevisableUntil(STARTS_AT),
        },
      },
    ]);
  });

  it('is refused beyond the recorded provision, naming it', () => {
    const sales = restored({
      capacityTotal: TECHNICAL_PROVISION_THRESHOLD,
      provisionedCapacity: 11_000,
    });

    const refusal = refusalOf(() => sales.openCapacityTier(3, 2_000, NOW));

    expect(refusal.code).toBe(CatalogErrorCode.TECHNICAL_PROVISION_REQUIRED);
    expect(refusal.params).toEqual({
      threshold: TECHNICAL_PROVISION_THRESHOLD,
      capacityTotal: 12_000,
      provisionedCapacity: 11_000,
    });
  });
});

describe('lockPrices', () => {
  it('locks the prices at the engagement, its event stated on ticketing’s clock', () => {
    const sales = restored({ priceTiers: [FULL] });

    expect(sales.lockPrices(STATED_AT, NOW)).toBe(true);
    expect(sales.snapshot.pricesLockedAt).toBe(STATED_AT);
    expect(sales.snapshot.version).toBe(4);
    expect(sales.getUncommittedEvents()).toMatchObject([
      { kind: 'DatePricesLocked', tiers: [FULL], occurredAt: NOW },
    ]);
  });

  it('locks once: a second engagement changes nothing', () => {
    const sales = restored({ pricesLockedAt: '2026-09-26T18:00:00.000Z' });

    expect(sales.lockPrices(STATED_AT, NOW)).toBe(false);
    expect(sales.snapshot.pricesLockedAt).toBe('2026-09-26T18:00:00.000Z');
    expect(sales.getUncommittedEvents()).toEqual([]);
  });
});

describe('recordSchedule', () => {
  it('records the start, and the provision it moves', () => {
    const sales = restored({ capacityTotal: TECHNICAL_PROVISION_THRESHOLD + 1 });

    expect(sales.recordSchedule(STARTS_AT, STATED_AT, NOW)).toBe(true);
    expect(sales.snapshot).toMatchObject({
      startsAt: STARTS_AT,
      scheduleStatedAt: STATED_AT,
      version: 4,
    });
    expect(sales.getUncommittedEvents()).toMatchObject([
      {
        kind: 'DateScheduleRecorded',
        startsAt: STARTS_AT,
        provision: { required: true, revisableUntil: '2026-12-09T19:00:00.000Z' },
      },
    ]);
  });

  it('refuses to let an older statement overwrite a newer one', () => {
    const moved = '2026-12-19T19:00:00.000Z';
    const sales = restored({ startsAt: moved, scheduleStatedAt: NOW });

    expect(sales.recordSchedule(STARTS_AT, '2026-09-27T09:59:59.999Z', NOW)).toBe(false);
    expect(sales.snapshot.startsAt).toBe(moved);
    expect(sales.snapshot.version).toBe(3);
  });

  it('applies a statement from the same instant again', () => {
    const sales = restored({ startsAt: STARTS_AT, scheduleStatedAt: STATED_AT });

    expect(sales.recordSchedule(STARTS_AT, STATED_AT, NOW)).toBe(true);
  });
});

describe('recordOutcome', () => {
  it.each([DateOutcome.CANCELLED, DateOutcome.INTERRUPTED])('closes the sale on %s', (outcome) => {
    const sales = restored({ pricesLockedAt: '2026-09-26T18:00:00.000Z' });

    expect(sales.recordOutcome(outcome, STATED_AT, NOW)).toBe(true);
    expect(sales.snapshot).toMatchObject({ outcome, salesClosedAt: STATED_AT, version: 4 });
    expect(sales.getUncommittedEvents()).toMatchObject([
      { kind: 'DateOutcomeRecorded', outcome, salesClosed: true, occurredAt: NOW },
    ]);
  });

  it('keeps selling a postponed date', () => {
    const sales = restored({ pricesLockedAt: '2026-09-26T18:00:00.000Z' });

    sales.recordOutcome(DateOutcome.POSTPONED, STATED_AT, NOW);

    expect(sales.snapshot.salesClosedAt).toBeNull();
    expect(sales.getUncommittedEvents()).toMatchObject([{ salesClosed: false }]);
  });

  it('refuses to let an older outcome overwrite a newer one', () => {
    const sales = restored({
      outcome: DateOutcome.CANCELLED,
      outcomeStatedAt: NOW,
      salesClosedAt: NOW,
    });

    expect(sales.recordOutcome(DateOutcome.POSTPONED, '2026-09-27T09:00:00.000Z', NOW)).toBe(false);
    expect(sales.snapshot.outcome).toBe(DateOutcome.CANCELLED);
  });
});

describe('the snapshot', () => {
  it('cannot be written in place, since the save diffs it against the one it loaded', () => {
    const sales = restored({ priceTiers: [FULL] });

    expect(() => {
      (sales.snapshot.priceTiers as TierPrice[]).push(REDUCED);
    }).toThrow(TypeError);
  });

  it('freezes its own copy of the prices it is handed, never the caller’s', () => {
    const tiers = [{ tier: PriceTier.REDUCED, amount: money(1600, 'EUR'), active: true }];
    const sales = restored();

    sales.setPrices(3, tiers, NOW);

    expect(sales.snapshot.priceTiers).toEqual(tiers);
    expect(Object.isFrozen(sales.snapshot.priceTiers[0]?.amount)).toBe(true);
    expect(Object.isFrozen(tiers)).toBe(false);
    expect(Object.isFrozen(tiers[0]?.amount)).toBe(false);
  });
});
