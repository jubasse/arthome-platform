import { describe, expect, it } from 'vitest';

import {
  CreditOrigin,
  PriceTier,
  RefundReason,
  SeatCancelReason,
  money,
  refundIdempotencyKey,
  type Money,
} from '@arthome/core';

import { cancelledDateSettlementOf, interruptedDateSettlementOf } from './order-outcome.js';
import { SeatOrder, type SeatOrderPlacement } from '../orders/seat-order.aggregate.js';

const NOW = '2026-10-02T10:00:00.000Z';
const REFUND_ID = '01a0e5ff-0000-7000-8000-000000000001';
const CREDIT_ID = '01a0e5cc-0000-7000-8000-000000000001';
const DATE_ID = '01a0e500-0000-7000-8000-00000000000d';
const ACCOUNT = '01a0e5aa-0000-7000-8000-000000000001';
const SEAT_IDS = [
  '01a0e500-0000-7000-8000-000000000503',
  '01a0e500-0000-7000-8000-000000000501',
  '01a0e500-0000-7000-8000-000000000502',
];
const IN_SEAT_ID_ORDER = [...SEAT_IDS].sort();

function placement(accountId: string | null): SeatOrderPlacement {
  return {
    id: '01a0e500-0000-7000-8000-00000000000a',
    reference: 'ATH-2026-00001',
    dateId: DATE_ID,
    channelId: 'channel-outcomes',
    accountId,
    profileId: null,
    tier: PriceTier.FULL,
    quantity: 3,
    quote: {
      unitPrice: money(2400, 'EUR'),
      tierTotal: money(7200, 'EUR'),
      serviceFee: money(0, 'EUR'),
      discount: money(0, 'EUR'),
      total: money(7200, 'EUR'),
    },
    declaredTaxLocation: null,
    holdId: '01a0e500-0000-7000-8000-0000000000b1',
    expiresAt: '2026-10-02T10:15:00.000Z',
  };
}

/** Paid for three seats, given `refunded` back already by a goodwill refund made. */
function paidOrder({
  accountId = ACCOUNT,
  refunded = null,
}: { accountId?: string | null; refunded?: Money | null } = {}): SeatOrder {
  const order = SeatOrder.place(placement(accountId), NOW);
  order.pay(
    'pi_fake_1',
    SEAT_IDS.map((id, index) => ({ id, code: `ATH-SEAT0${String(index)}`, cancelDeadline: null })),
    NOW,
  );
  if (refunded !== null) {
    const goodwill = '01a0e5ff-0000-7000-8000-0000000000aa';
    order.oweRefund(
      {
        id: goodwill,
        amount: refunded,
        reason: RefundReason.GOODWILL,
        idempotencyKey: refundIdempotencyKey(goodwill),
        seatId: null,
      },
      NOW,
    );
    order.refundMade(goodwill, 're_goodwill', NOW);
  }
  return order;
}

const minorOf = (amount: Money | null): number | null => amount?.amountMinor ?? null;

describe('a cancelled date, per order', () => {
  it('owes what is left in one refund, its seats cancelled with shares adding up to it', () => {
    const settled = cancelledDateSettlementOf(
      paidOrder({ refunded: money(1000, 'EUR') }),
      REFUND_ID,
    );

    expect(settled?.refund).toEqual({
      id: REFUND_ID,
      amount: money(6200, 'EUR'),
      reason: RefundReason.DATE_CANCELLED,
      idempotencyKey: refundIdempotencyKey(REFUND_ID),
      seatId: null,
    });
    expect(settled?.cancellation.reason).toBe(SeatCancelReason.DATE_CANCELLED);
    expect(settled?.cancellation.refundId).toBe(REFUND_ID);
    expect(
      settled?.cancellation.seats.map(({ seatId, refundAmount }) => [
        seatId,
        minorOf(refundAmount),
      ]),
    ).toEqual([
      [IN_SEAT_ID_ORDER[0], 2067],
      [IN_SEAT_ID_ORDER[1], 2067],
      [IN_SEAT_ID_ORDER[2], 2066],
    ]);
  });

  it('cancels the seats of an order refunded in full with nothing given back', () => {
    const settled = cancelledDateSettlementOf(
      paidOrder({ refunded: money(7200, 'EUR') }),
      REFUND_ID,
    );

    expect(settled?.refund).toBeNull();
    expect(settled?.cancellation.refundId).toBeNull();
    expect(settled?.cancellation.seats.map(({ refundAmount }) => refundAmount)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('owes nothing on a disputed order, the provider holding its money, and cancels its seats', () => {
    const order = paidOrder();
    order.dispute();

    const settled = cancelledDateSettlementOf(order, REFUND_ID);

    expect(settled?.refund).toBeNull();
    expect(settled?.cancellation.seats).toHaveLength(3);
  });

  it('settles nothing on an order holding no active seat', () => {
    const order = paidOrder();
    order.cancelSeats(
      {
        reason: SeatCancelReason.VIEWER_REQUEST,
        refundId: null,
        seats: SEAT_IDS.map((seatId) => ({ seatId, refundAmount: null })),
      },
      NOW,
    );

    expect(cancelledDateSettlementOf(order, REFUND_ID)).toBeNull();
  });

  it('splits what is left over the seats still active only', () => {
    const order = paidOrder();
    order.cancelSeats(
      {
        reason: SeatCancelReason.VIEWER_REQUEST,
        refundId: null,
        seats: [{ seatId: IN_SEAT_ID_ORDER[0] ?? '', refundAmount: null }],
      },
      NOW,
    );

    const settled = cancelledDateSettlementOf(order, REFUND_ID);

    expect(
      settled?.cancellation.seats.map(({ seatId, refundAmount }) => [
        seatId,
        minorOf(refundAmount),
      ]),
    ).toEqual([
      [IN_SEAT_ID_ORDER[1], 3600],
      [IN_SEAT_ID_ORDER[2], 3600],
    ]);
  });
});

describe('an interrupted date, per order', () => {
  it("credits what is left on the order's account and channel, shares adding up to it", () => {
    const settled = interruptedDateSettlementOf(
      paidOrder({ refunded: money(1000, 'EUR') }),
      CREDIT_ID,
    );

    expect(settled).toEqual({
      kind: 'credit_owed',
      credit: {
        id: CREDIT_ID,
        accountId: ACCOUNT,
        channelId: 'channel-outcomes',
        orderId: '01a0e500-0000-7000-8000-00000000000a',
        amount: money(6200, 'EUR'),
        origin: CreditOrigin.INTERRUPTED_DATE,
        originRef: DATE_ID,
      },
      crediting: {
        creditId: CREDIT_ID,
        seats: [
          { seatId: IN_SEAT_ID_ORDER[0], creditAmount: money(2067, 'EUR') },
          { seatId: IN_SEAT_ID_ORDER[1], creditAmount: money(2067, 'EUR') },
          { seatId: IN_SEAT_ID_ORDER[2], creditAmount: money(2066, 'EUR') },
        ],
      },
    });
  });

  it('gives a seat a share of nothing when the credit has fewer minor units than seats', () => {
    const settled = interruptedDateSettlementOf(
      paidOrder({ refunded: money(7198, 'EUR') }),
      CREDIT_ID,
    );

    expect(
      settled.kind === 'credit_owed' &&
        settled.crediting.seats.map(({ creditAmount }) => creditAmount.amountMinor),
    ).toEqual([1, 1, 0]);
  });

  it('leaves an order with nothing left, or disputed', () => {
    const disputed = paidOrder();
    disputed.dispute();

    expect(
      interruptedDateSettlementOf(paidOrder({ refunded: money(7200, 'EUR') }), CREDIT_ID),
    ).toEqual({ kind: 'nothing_owed', because: 'nothing_left' });
    expect(interruptedDateSettlementOf(disputed, CREDIT_ID)).toEqual({
      kind: 'nothing_owed',
      because: 'nothing_left',
    });
  });

  it('leaves an order with no account: a credit is an account’s', () => {
    expect(interruptedDateSettlementOf(paidOrder({ accountId: null }), CREDIT_ID)).toEqual({
      kind: 'nothing_owed',
      because: 'no_account',
    });
  });
});
