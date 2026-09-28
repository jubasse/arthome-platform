import {
  OrderKind as WireOrderKind,
  OrderPaidSchema,
  OrderRefundedSchema,
  SeatActivatedSchema,
  SeatCancelReason as WireSeatCancelReason,
  TaxEvidenceKind as WireTaxEvidenceKind,
} from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EntityManager } from 'typeorm';

import { zero, type Money } from '@arthome/core';

import type { DeclaredTaxLocation } from './seat-order.aggregate.js';
import type { SeatOrderEvent, SeatOrderPaid, SeatOrderRefunded } from './seat-order.events.js';
import { assertNever } from '../assert-never.js';
import { writeTicketingEvent, type TicketingEvent } from '../ticketing-events.js';
import { WIRE_PRICE_TIER, WIRE_REFUND_REASON } from '../wire.js';

/** What the wire says beyond the aggregate's facts. */
export interface SeatOrderWireContext {
  /** The purchase's or the webhook's, so the trace runs on through ticketing. */
  readonly traceparent: string | null;
}

/**
 * The outbox rows of an order's events, in the order they were applied: `order.paid` keyed by the
 *   order, then one `seat.activated` per seat keyed by the date (events.md §3.1, D-078).
 */
export async function writeSeatOrderIntegrationEvents(
  manager: EntityManager,
  events: readonly SeatOrderEvent[],
  context: SeatOrderWireContext,
): Promise<void> {
  for (const event of events) {
    for (const integration of integrationEventsOf(event, context)) {
      await writeTicketingEvent(manager, integration, new Date(event.occurredAt));
    }
  }
}

function integrationEventsOf(
  event: SeatOrderEvent,
  context: SeatOrderWireContext,
): readonly TicketingEvent[] {
  switch (event.kind) {
    case 'SeatOrderPlaced':
    case 'SeatOrderHoldRenewed':
    case 'SeatOrderIntentRecorded':
    case 'SeatOrderFailed':
    case 'SeatOrderRefundOwed':
      return [];
    case 'SeatOrderPaid':
      return [orderPaid(event, context), ...seatsActivated(event, context)];
    case 'SeatOrderRefunded':
      return [orderRefunded(event, context)];
    default:
      return assertNever(event);
  }
}

function wireMoney({ amountMinor, currencyCode }: Money): {
  amountMinor: bigint;
  currencyCode: string;
} {
  return { amountMinor: BigInt(amountMinor), currencyCode };
}

/**
 * `vat` stays empty and the location carries the buyer's declaration alone, unresolved: the tax
 *   model awaits counsel (adr-payments.md §5.5) and `payouts` computes the VAT (adr-ticketing.md).
 *   An account is unknown until tokens are verified, so `account_id` is empty.
 */
function orderPaid(event: SeatOrderPaid, context: SeatOrderWireContext): TicketingEvent {
  const occurredAt = timestampFromDate(new Date(event.occurredAt));
  return {
    type: 'ticketing.order.paid.v1',
    key: event.orderId,
    payload: toBinary(
      OrderPaidSchema,
      create(OrderPaidSchema, {
        orderId: event.orderId,
        kind: WireOrderKind.SEAT,
        channelId: event.channelId,
        dateId: event.dateId,
        accountId: event.accountId ?? '',
        grossTtc: wireMoney(event.quote.total),
        serviceFee: wireMoney(event.quote.serviceFee),
        discount: wireMoney(event.quote.discount),
        creditApplied: wireMoney(zero(event.quote.total.currencyCode)),
        paymentIntentRef: event.intentRef,
        paidAt: occurredAt,
        ...(event.declaredTaxLocation !== null && {
          buyerTaxLocation: declaredLocationOf(event.declaredTaxLocation, occurredAt),
        }),
      }),
    ),
    traceparent: context.traceparent,
  };
}

function declaredLocationOf(
  declared: DeclaredTaxLocation,
  collectedAt: ReturnType<typeof timestampFromDate>,
) {
  return {
    country: declared.country,
    subdivision: declared.subdivision ?? '',
    postalCode: declared.postalCode ?? '',
    evidence: [
      {
        kind: WireTaxEvidenceKind.DECLARED_BY_BUYER,
        country: declared.country,
        subdivision: declared.subdivision ?? '',
        source: 'purchase.declared_tax_location',
        collectedAt,
      },
    ],
  };
}

function seatsActivated(event: SeatOrderPaid, context: SeatOrderWireContext): TicketingEvent[] {
  return event.seats.map((seat) => ({
    type: 'ticketing.seat.activated.v1',
    key: event.dateId,
    payload: toBinary(
      SeatActivatedSchema,
      create(SeatActivatedSchema, {
        seatId: seat.id,
        orderId: event.orderId,
        dateId: event.dateId,
        accountId: event.accountId ?? '',
        profileId: event.profileId ?? '',
        tier: WIRE_PRICE_TIER[seat.tier],
        seatCode: seat.code,
        ...(seat.cancelDeadline !== null && {
          cancelDeadline: timestampFromDate(new Date(seat.cancelDeadline)),
        }),
        occurredAt: timestampFromDate(new Date(event.occurredAt)),
      }),
    ),
    traceparent: context.traceparent,
  }));
}

/** No seat was ever created for it, so `reason`, the seat's cancellation, stays unspecified. */
function orderRefunded(event: SeatOrderRefunded, context: SeatOrderWireContext): TicketingEvent {
  return {
    type: 'ticketing.order.refunded.v1',
    key: event.orderId,
    payload: toBinary(
      OrderRefundedSchema,
      create(OrderRefundedSchema, {
        orderId: event.orderId,
        channelId: event.channelId,
        amount: wireMoney(event.amount),
        reason: WireSeatCancelReason.UNSPECIFIED,
        refundRef: event.refundRef,
        occurredAt: timestampFromDate(new Date(event.occurredAt)),
        refundReason: WIRE_REFUND_REASON[event.reason],
      }),
    ),
    traceparent: context.traceparent,
  };
}
