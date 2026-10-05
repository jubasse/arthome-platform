import { describe, expect, it } from 'vitest';

import {
  OrderErrorCode,
  PriceTier,
  RefundReason,
  money,
  OrderState,
  SeatState,
} from '@arthome/core';

import { SeatOrder, type SeatIssue, type SeatOrderPlacement } from './seat-order.aggregate.js';
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

  it('owes back a payment it has no seat for, and takes no payment after that', () => {
    const order = placed();
    order.fail({ code: null, declineCode: null }, NOW);

    order.oweRefund(RefundReason.HOLD_EXPIRED_CAPACITY_LOST, INTENT.ref, LATER);
    order.pay(INTENT.ref, ISSUES, LATER);

    expect(order.owesRefund).toBe(true);
    expect(order.snapshot.seats).toEqual([]);

    order.markRefunded('re_fake_1', LATER);

    expect(order.snapshot).toMatchObject({
      state: OrderState.REFUNDED,
      refund: {
        reason: RefundReason.HOLD_EXPIRED_CAPACITY_LOST,
        ref: 're_fake_1',
        refundedAt: LATER,
      },
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
