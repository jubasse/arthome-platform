import { describe, expect, it } from 'vitest';

import {
  OrderErrorCode,
  PriceTier,
  RefundReason,
  money,
  OrderState,
  SeatCancelReason,
  SeatState,
} from '@arthome/core';

import {
  SeatOrder,
  type OwedRefund,
  type SeatIssue,
  type SeatOrderPlacement,
} from './seat-order.aggregate.js';
import type { SeatCancelled } from './seat-order.events.js';
import { NextActionKind } from '../payments/next-action.js';

const NOW = '2026-09-28T10:00:00.000Z';
const LATER = '2026-09-28T10:05:00.000Z';
const ORDER_ID = '01a0f700-0000-7000-8000-00000000000a';
const INTENT = { ref: 'pi_fake_1', clientSecret: 'pi_fake_1_secret', nextAction: null };

const PLACEMENT: SeatOrderPlacement = {
  id: ORDER_ID,
  reference: 'ATH-2026-00001',
  dateId: '01a0f700-0000-7000-8000-00000000000d',
  channelId: '01a0f700-0000-7000-8000-00000000000c',
  accountId: null,
  profileId: null,
  tier: PriceTier.FULL,
  quantity: 2,
  quote: {
    unitPrice: money(2400, 'EUR'),
    tierTotal: money(4800, 'EUR'),
    serviceFee: money(0, 'EUR'),
    discount: money(0, 'EUR'),
    total: money(4800, 'EUR'),
  },
  declaredTaxLocation: null,
  holdId: '01a0f700-0000-7000-8000-0000000000b1',
  expiresAt: '2026-09-28T10:15:00.000Z',
};

const ISSUES: SeatIssue[] = [
  { id: '01a0f700-0000-7000-8000-000000000501', code: 'ATH-7QK24M', cancelDeadline: null },
  { id: '01a0f700-0000-7000-8000-000000000502', code: 'ATH-8RM35N', cancelDeadline: null },
];

const placed = (): SeatOrder => SeatOrder.place(PLACEMENT, NOW);

describe('SeatOrder', () => {
  it('is placed pending, waiting for its intent', () => {
    const order = placed();

    expect(order.snapshot).toMatchObject({ state: OrderState.PENDING, placedAt: NOW, version: 1 });
    expect(order.awaitsIntent).toBe(true);
    expect(order.getUncommittedEvents()).toMatchObject([{ kind: 'SeatOrderPlaced' }]);
  });

  it('moves forward only: a state behind the current one is ignored, never applied', () => {
    const order = placed();

    order.recordIntent(INTENT, OrderState.PROCESSING, NOW);
    order.recordIntent(INTENT, OrderState.AWAITING_ACTION, LATER);

    expect(order.snapshot).toMatchObject({ state: OrderState.PROCESSING, intent: INTENT });
  });

  it('creates one seat per seat bought when paid, and nothing on a second confirmation', () => {
    const order = placed();
    order.recordIntent(INTENT, OrderState.AWAITING_ACTION, NOW);

    order.pay(INTENT.ref, ISSUES, LATER);
    order.pay(INTENT.ref, ISSUES, LATER);

    expect(order.snapshot).toMatchObject({ state: OrderState.PAID, paidAt: LATER });
    expect(order.snapshot.seats.map(({ code, state }) => [code, state])).toEqual([
      ['ATH-7QK24M', SeatState.ACTIVE],
      ['ATH-8RM35N', SeatState.ACTIVE],
    ]);
    expect(order.getUncommittedEvents().map(({ kind }) => kind)).toEqual([
      'SeatOrderPlaced',
      'SeatOrderIntentRecorded',
      'SeatOrderPaid',
    ]);
    expect(order.fail({ code: OrderErrorCode.PAYMENT_DECLINED, declineCode: null }, LATER)).toBe(
      false,
    );
  });

  it('refuses a payment that would issue another number of seats than it sold', () => {
    expect(() => placed().pay(INTENT.ref, ISSUES.slice(1), LATER)).toThrow(/buys 2 seats, not 1/);
  });

  it('is still paid by a confirmation arriving after it failed (D-082)', () => {
    const order = placed();
    order.fail({ code: null, declineCode: null }, NOW);

    order.pay(INTENT.ref, ISSUES, LATER);

    expect(order.snapshot).toMatchObject({ state: OrderState.PAID, failure: null });
  });

  it('owes the cancellation of an intent that reaches it once failed', () => {
    const order = placed();
    order.fail({ code: null, declineCode: null }, NOW);

    order.recordIntent(INTENT, OrderState.AWAITING_ACTION, LATER);

    expect(order.snapshot).toMatchObject({
      state: OrderState.FAILED,
      intent: INTENT,
      intentCancelOwedAt: LATER,
    });
  });

  it('keeps the instant it first owed that cancellation when the intent reaches it again', () => {
    const order = placed();
    order.fail({ code: null, declineCode: null }, NOW);

    const first = order.recordIntent(INTENT, OrderState.AWAITING_ACTION, NOW);
    const again = order.recordIntent(INTENT, OrderState.PROCESSING, LATER);

    expect([first, again]).toEqual([true, true]);
    expect(order.snapshot).toMatchObject({ state: OrderState.FAILED, intentCancelOwedAt: NOW });
  });

  it('owes no cancellation for an intent it still waits on', () => {
    expect(placed().recordIntent(INTENT, OrderState.AWAITING_ACTION, NOW)).toBe(false);
  });

  it('owes back a payment it has no seat for, under its own key, and takes no payment after that (D-082)', () => {
    const order = placed();
    order.fail({ code: null, declineCode: null }, NOW);

    const refundId = order.oweUnseatedPaymentBack(
      RefundReason.HOLD_EXPIRED_CAPACITY_LOST,
      INTENT.ref,
      LATER,
    );
    order.pay(INTENT.ref, ISSUES, LATER);

    expect(order.owesRefund).toBe(true);
    expect(order.acceptsPayment).toBe(false);
    expect(order.snapshot.seats).toEqual([]);
    expect(order.snapshot.refunds).toEqual([
      {
        id: refundId,
        amount: PLACEMENT.quote.total,
        reason: RefundReason.HOLD_EXPIRED_CAPACITY_LOST,
        idempotencyKey: `refund:${refundId ?? ''}`,
        seatId: null,
        owedAt: LATER,
        ref: null,
        refundedAt: null,
      },
    ]);
    expect(
      order.oweUnseatedPaymentBack(RefundReason.HOLD_EXPIRED_CAPACITY_LOST, INTENT.ref, LATER),
    ).toBeNull();

    order.refundMade(refundId ?? '', 're_fake_1', LATER);

    expect(order.snapshot).toMatchObject({
      state: OrderState.REFUNDED,
      refunds: [{ ref: 're_fake_1', refundedAt: LATER }],
    });
    expect(order.owesRefund).toBe(false);
    expect(order.getUncommittedEvents().map(({ kind }) => kind)).toEqual([
      'SeatOrderPlaced',
      'SeatOrderFailed',
      'SeatOrderRefundOwed',
      'SeatOrderRefunded',
    ]);
  });

  it('cannot be written in place', () => {
    const order = placed();

    expect(() => {
      (order.snapshot as { state: string }).state = OrderState.PAID;
    }).toThrow(TypeError);
  });
});

describe('SeatOrder, its intent told in either order (review M4)', () => {
  const learnt = { ref: INTENT.ref, clientSecret: null, nextAction: null };
  const told = {
    ref: INTENT.ref,
    clientSecret: INTENT.clientSecret,
    nextAction: { kind: NextActionKind.REDIRECT_TO_URL, redirectUrl: 'https://3ds.test' },
  };

  it('completes an intent its webhook recorded with the secret the purchase is told', () => {
    const order = placed();
    order.recordIntent(learnt, OrderState.AWAITING_ACTION, NOW);
    expect(order.awaitsClientSecret).toBe(true);

    order.recordIntent(told, OrderState.AWAITING_ACTION, LATER);

    expect(order.snapshot).toMatchObject({ state: OrderState.AWAITING_ACTION, intent: told });
    expect(order.awaitsClientSecret).toBe(false);
  });

  it('keeps the secret it knows when the webhook comes second, and moves nothing for another ref', () => {
    const order = placed();
    order.recordIntent(told, OrderState.AWAITING_ACTION, NOW);
    const version = order.snapshot.version;

    order.recordIntent(learnt, OrderState.AWAITING_ACTION, LATER);
    order.recordIntent({ ...told, ref: 'pi_other' }, OrderState.AWAITING_ACTION, LATER);

    expect(order.snapshot).toMatchObject({ intent: told, version });
  });
});

describe('SeatOrder, its refunds (the ledger PT1 and PT2 owe through)', () => {
  const paid = (): SeatOrder => {
    const order = placed();
    order.pay(INTENT.ref, ISSUES, NOW);
    return order;
  };
  const refundOf = (id: string, amountMinor: number, seatId: string | null): OwedRefund => ({
    id,
    amount: money(amountMinor, 'EUR'),
    reason: RefundReason.VIEWER_REQUEST,
    idempotencyKey: `refund:${id}`,
    seatId,
  });
  const FIRST = refundOf('01a0f700-0000-7000-8000-0000000000f1', 2400, ISSUES[0]?.id ?? null);
  const SECOND = refundOf('01a0f700-0000-7000-8000-0000000000f2', 2400, ISSUES[1]?.id ?? null);

  it('is partially refunded by a first refund made, then refunded once they reach the total', () => {
    const order = paid();

    order.oweRefund(FIRST, LATER);
    order.oweRefund(SECOND, LATER);
    expect(order.refundableLeft).toEqual(money(0, 'EUR'));

    order.refundMade(FIRST.id, 're_fake_1', LATER);
    expect(order.snapshot.state).toBe(OrderState.PARTIALLY_REFUNDED);
    expect(order.owesRefund).toBe(true);

    order.refundMade(SECOND.id, 're_fake_2', LATER);
    order.refundMade(SECOND.id, 're_fake_2', LATER);
    expect(order.snapshot.state).toBe(OrderState.REFUNDED);
    expect(order.owesRefund).toBe(false);

    const events = order.getUncommittedEvents();
    expect(events.map(({ kind }) => kind)).toEqual([
      'SeatOrderPlaced',
      'SeatOrderPaid',
      'SeatOrderRefundOwed',
      'SeatOrderRefundOwed',
      'SeatOrderRefunded',
      'SeatOrderRefunded',
    ]);
    expect(events.at(-1)).toMatchObject({ refundId: SECOND.id, amount: SECOND.amount });
  });

  it('refuses a refund past what is left, and one of nothing', () => {
    const order = paid();
    order.oweRefund(FIRST, LATER);

    expect(order.refundableLeft).toEqual(money(2400, 'EUR'));
    expect(() => {
      order.oweRefund({ ...SECOND, amount: money(2401, 'EUR') }, LATER);
    }).toThrow(
      expect.objectContaining({
        code: OrderErrorCode.REFUND_AMOUNT_EXCEEDS_REMAINING,
        params: { remainingMinor: 2400, currencyCode: 'EUR' },
      }),
    );
    expect(() => {
      order.oweRefund({ ...SECOND, amount: money(0, 'EUR') }, LATER);
    }).toThrow(/a refund of nothing/);
    expect(order.snapshot.refunds).toHaveLength(1);
  });

  it('owes no refund on an order that holds no money, nor accepts a payment once one is owed', () => {
    expect(() => {
      placed().oweRefund(FIRST, LATER);
    }).toThrow(/is pending: it holds no money to refund/);

    const order = placed();
    order.fail({ code: null, declineCode: null }, NOW);
    order.oweUnseatedPaymentBack(RefundReason.HOLD_EXPIRED_CAPACITY_LOST, INTENT.ref, LATER);
    expect(() => {
      order.oweRefund(FIRST, LATER);
    }).toThrow(/is failed/);
  });

  it('answers a refund owed again with the same facts, and refuses its id or key with others', () => {
    const order = paid();
    const first = order.oweRefund(FIRST, LATER);
    const version = order.snapshot.version;

    expect(order.oweRefund(FIRST, LATER)).toEqual(first);
    expect(order.snapshot.refunds).toHaveLength(1);
    expect(order.snapshot.version).toBe(version);
    expect(() => {
      order.oweRefund({ ...FIRST, amount: money(100, 'EUR') }, LATER);
    }).toThrow(/already owes refund/);
    expect(() => {
      order.oweRefund({ ...SECOND, idempotencyKey: FIRST.idempotencyKey }, LATER);
    }).toThrow(/already owes refund/);

    order.refundMade(FIRST.id, 're_fake_1', LATER);
    expect(order.oweRefund(FIRST, LATER)).toMatchObject({ id: FIRST.id, ref: 're_fake_1' });
    expect(
      order.getUncommittedEvents().filter(({ kind }) => kind === 'SeatOrderRefundOwed'),
    ).toHaveLength(1);
  });

  it('refuses to mark made a refund it does not owe', () => {
    expect(() => {
      paid().refundMade(FIRST.id, 're_fake_1', LATER);
    }).toThrow(/owes no refund/);
  });
});

describe('SeatOrder, its seats leaving active (S1 to S3)', () => {
  const THREE: SeatIssue[] = [
    ...ISSUES,
    { id: '01a0f700-0000-7000-8000-000000000503', code: 'ATH-9SN46P', cancelDeadline: null },
  ];
  const [FIRST_SEAT, SECOND_SEAT, THIRD_SEAT] = THREE.map(({ id }) => id) as [
    string,
    string,
    string,
  ];
  const REFUND_ID = '01a0f700-0000-7000-8000-0000000000f3';
  const paidForThree = (): SeatOrder => {
    const order = SeatOrder.place(
      {
        ...PLACEMENT,
        accountId: '01a0f700-0000-7000-8000-0000000000aa',
        quantity: 3,
        quote: { ...PLACEMENT.quote, tierTotal: money(7200, 'EUR'), total: money(7200, 'EUR') },
      },
      NOW,
    );
    order.pay(INTENT.ref, THREE, NOW);
    return order;
  };
  const oweFor = (order: SeatOrder, seatId: string | null, amountMinor = 2400): void => {
    order.oweRefund(
      {
        id: REFUND_ID,
        amount: money(amountMinor, 'EUR'),
        reason: RefundReason.VIEWER_REQUEST,
        idempotencyKey: `refund:${REFUND_ID}`,
        seatId,
      },
      LATER,
    );
  };
  const statesOf = (order: SeatOrder) =>
    Object.fromEntries(order.snapshot.seats.map(({ id, state }) => [id, state]));

  it('cancels one seat of three at once, then refunds it when its refund is made', () => {
    const order = paidForThree();
    oweFor(order, FIRST_SEAT);

    order.cancelSeats(
      {
        reason: SeatCancelReason.VIEWER_REQUEST,
        refundId: REFUND_ID,
        seats: [{ seatId: FIRST_SEAT, refundAmount: money(2400, 'EUR') }],
      },
      LATER,
    );
    expect(statesOf(order)).toEqual({
      [FIRST_SEAT]: SeatState.CANCELLED,
      [SECOND_SEAT]: SeatState.ACTIVE,
      [THIRD_SEAT]: SeatState.ACTIVE,
    });
    expect(order.snapshot.seats[0]).toMatchObject({
      endedAt: LATER,
      cancelReason: SeatCancelReason.VIEWER_REQUEST,
      refundId: REFUND_ID,
      refundAmount: money(2400, 'EUR'),
    });

    order.refundMade(REFUND_ID, 're_fake_1', LATER);
    expect(statesOf(order)).toEqual({
      [FIRST_SEAT]: SeatState.REFUNDED,
      [SECOND_SEAT]: SeatState.ACTIVE,
      [THIRD_SEAT]: SeatState.ACTIVE,
    });
    expect(order.snapshot.state).toBe(OrderState.PARTIALLY_REFUNDED);
    expect(order.snapshot.seats[0]?.endedAt).toBe(LATER);
  });

  it('writes one SeatCancelled per seat, on the date, for the seat’s account', () => {
    const order = paidForThree();
    oweFor(order, null, 4800);

    order.cancelSeats(
      {
        reason: SeatCancelReason.DATE_CANCELLED,
        refundId: REFUND_ID,
        seats: [
          { seatId: FIRST_SEAT, refundAmount: money(2400, 'EUR') },
          { seatId: SECOND_SEAT, refundAmount: money(2400, 'EUR') },
        ],
      },
      LATER,
    );

    const cancelled = order
      .getUncommittedEvents()
      .filter((event): event is SeatCancelled => event.kind === 'SeatCancelled');
    expect(cancelled.map(({ seatId }) => seatId)).toEqual([FIRST_SEAT, SECOND_SEAT]);
    expect(cancelled[0]).toMatchObject({
      dateId: PLACEMENT.dateId,
      accountId: '01a0f700-0000-7000-8000-0000000000aa',
      reason: SeatCancelReason.DATE_CANCELLED,
      occurredAt: LATER,
    });
    order.refundMade(REFUND_ID, 're_fake_1', LATER);
    expect(statesOf(order)).toEqual({
      [FIRST_SEAT]: SeatState.REFUNDED,
      [SECOND_SEAT]: SeatState.REFUNDED,
      [THIRD_SEAT]: SeatState.ACTIVE,
    });
  });

  it('keeps a seat cancelled for good when nothing is given back, a share of nothing included', () => {
    const order = paidForThree();
    oweFor(order, null, 2);

    order.cancelSeats(
      {
        reason: SeatCancelReason.DATE_CANCELLED,
        refundId: REFUND_ID,
        seats: [
          { seatId: FIRST_SEAT, refundAmount: money(1, 'EUR') },
          { seatId: SECOND_SEAT, refundAmount: money(1, 'EUR') },
          { seatId: THIRD_SEAT, refundAmount: money(0, 'EUR') },
        ],
      },
      LATER,
    );
    expect(order.snapshot.seats[2]).toMatchObject({ refundId: null, refundAmount: null });
    order.refundMade(REFUND_ID, 're_fake_1', LATER);
    expect(statesOf(order)[THIRD_SEAT]).toBe(SeatState.CANCELLED);

    const disputed = paidForThree();
    disputed.dispute();
    disputed.cancelSeats(
      {
        reason: SeatCancelReason.VIEWER_REQUEST,
        refundId: null,
        seats: [{ seatId: FIRST_SEAT, refundAmount: null }],
      },
      LATER,
    );
    expect(disputed.snapshot.seats[0]).toMatchObject({
      state: SeatState.CANCELLED,
      refundId: null,
      refundAmount: null,
    });
  });

  it('refuses a seat no longer active with seat.not_active and its state, and moves nothing', () => {
    const order = paidForThree();
    const cancel = (seatId: string) => {
      order.cancelSeats(
        {
          reason: SeatCancelReason.VIEWER_REQUEST,
          refundId: null,
          seats: [{ seatId, refundAmount: null }],
        },
        LATER,
      );
    };
    cancel(FIRST_SEAT);
    const version = order.snapshot.version;

    expect(() => {
      cancel(FIRST_SEAT);
    }).toThrow(
      expect.objectContaining({
        code: OrderErrorCode.SEAT_NOT_ACTIVE,
        params: { state: SeatState.CANCELLED },
      }),
    );
    expect(() => {
      order.creditSeats(
        {
          creditId: '01a0f700-0000-7000-8000-0000000000c1',
          seats: [
            { seatId: SECOND_SEAT, creditAmount: money(2400, 'EUR') },
            { seatId: FIRST_SEAT, creditAmount: money(2400, 'EUR') },
          ],
        },
        LATER,
      );
    }).toThrow(expect.objectContaining({ code: OrderErrorCode.SEAT_NOT_ACTIVE }));
    expect(order.snapshot.version).toBe(version);
    expect(statesOf(order)[SECOND_SEAT]).toBe(SeatState.ACTIVE);
  });

  it('credits a seat whose share of the credit is nothing, as its order’s other seats', () => {
    const order = paidForThree();

    order.creditSeats(
      {
        creditId: '01a0f700-0000-7000-8000-0000000000c2',
        seats: [
          { seatId: FIRST_SEAT, creditAmount: money(1, 'EUR') },
          { seatId: SECOND_SEAT, creditAmount: money(1, 'EUR') },
          { seatId: THIRD_SEAT, creditAmount: money(0, 'EUR') },
        ],
      },
      LATER,
    );

    expect(order.snapshot.seats[2]).toMatchObject({
      state: SeatState.CREDITED,
      creditAmount: money(0, 'EUR'),
    });
  });

  it('credits seats with their shares, with no event for the wire', () => {
    const order = paidForThree();
    const creditId = '01a0f700-0000-7000-8000-0000000000c1';

    order.creditSeats(
      {
        creditId,
        seats: [
          { seatId: FIRST_SEAT, creditAmount: money(2400, 'EUR') },
          { seatId: SECOND_SEAT, creditAmount: money(2400, 'EUR') },
        ],
      },
      LATER,
    );

    expect(order.snapshot.seats[0]).toMatchObject({
      state: SeatState.CREDITED,
      endedAt: LATER,
      creditId,
      creditAmount: money(2400, 'EUR'),
    });
    expect(statesOf(order)[THIRD_SEAT]).toBe(SeatState.ACTIVE);
    expect(order.getUncommittedEvents().at(-1)).toMatchObject({
      kind: 'SeatsCredited',
      creditId,
      seatIds: [FIRST_SEAT, SECOND_SEAT],
    });
  });

  it('is disputed above refunded, its seats left active, and owes no refund after', () => {
    const order = paidForThree();
    const events = order.getUncommittedEvents().length;

    expect(order.dispute()).toBe(true);
    expect(order.dispute()).toBe(false);

    expect(order.snapshot.state).toBe(OrderState.DISPUTED);
    expect(Object.values(statesOf(order))).toEqual([
      SeatState.ACTIVE,
      SeatState.ACTIVE,
      SeatState.ACTIVE,
    ]);
    expect(order.getUncommittedEvents()).toHaveLength(events);
    expect(() => {
      oweFor(order, FIRST_SEAT);
    }).toThrow(/is disputed/);
  });

  it('takes the provider’s reference of a refund made before it was named, with no second event', () => {
    const order = paidForThree();
    oweFor(order, FIRST_SEAT);

    order.refundMade(REFUND_ID, null, LATER);
    order.refundMade(REFUND_ID, 're_fake_1', LATER);
    order.refundMade(REFUND_ID, 're_fake_other', LATER);

    expect(order.snapshot.refunds[0]).toMatchObject({ ref: 're_fake_1', refundedAt: LATER });
    expect(
      order.getUncommittedEvents().filter(({ kind }) => kind === 'SeatOrderRefunded'),
    ).toHaveLength(1);
  });
});

describe('SeatOrder, the refunds a webhook reports made', () => {
  const owe = (order: SeatOrder, id: string, amountMinor: number): void => {
    order.oweRefund(
      {
        id,
        amount: money(amountMinor, 'EUR'),
        reason: RefundReason.GOODWILL,
        idempotencyKey: `refund:${id}`,
        seatId: null,
      },
      NOW,
    );
  };
  const FIRST = '01a0f700-0000-7000-8000-0000000000e1';
  const SECOND = '01a0f700-0000-7000-8000-0000000000e2';
  const paidOwingTwo = (): SeatOrder => {
    const order = placed();
    order.pay(INTENT.ref, ISSUES, NOW);
    owe(order, FIRST, 1000);
    owe(order, SECOND, 500);
    return order;
  };
  const made = (order: SeatOrder) =>
    order.snapshot.refunds.map(({ ref, refundedAt }) => [ref, refundedAt]);
  const refundedEvents = (order: SeatOrder) =>
    order.getUncommittedEvents().filter(({ kind }) => kind === 'SeatOrderRefunded');

  it('makes the refunds the cumulative covers, oldest first, the newest taking the reference', () => {
    const order = paidOwingTwo();

    expect(order.refundsReported('re_1', money(1000, 'EUR'), LATER)).toBe(true);
    expect(made(order)).toEqual([
      ['re_1', LATER],
      [null, null],
    ]);
    expect(order.refundsReported('re_1', money(1000, 'EUR'), LATER)).toBe(true);
    expect(order.refundsReported('re_2', money(1500, 'EUR'), LATER)).toBe(true);
    expect(made(order)).toEqual([
      ['re_1', LATER],
      ['re_2', LATER],
    ]);
    expect(refundedEvents(order)).toHaveLength(2);
    expect(order.snapshot.state).toBe(OrderState.PARTIALLY_REFUNDED);
  });

  it('makes both when the later one is reported first, then names the earlier one', () => {
    const order = paidOwingTwo();

    order.refundsReported('re_2', money(1500, 'EUR'), LATER);
    expect(made(order)).toEqual([
      [null, LATER],
      ['re_2', LATER],
    ]);
    order.refundsReported('re_1', money(1000, 'EUR'), LATER);
    expect(made(order)).toEqual([
      ['re_1', LATER],
      ['re_2', LATER],
    ]);
    expect(refundedEvents(order)).toHaveLength(2);
  });

  it('ignores a cumulative past every refund it holds, and makes none a partial sum leaves out', () => {
    const order = paidOwingTwo();

    expect(order.refundsReported('re_outside', money(1501, 'EUR'), LATER)).toBe(false);
    expect(order.refundsReported('re_small', money(999, 'EUR'), LATER)).toBe(true);
    expect(made(order)).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(refundedEvents(order)).toEqual([]);
  });
});
