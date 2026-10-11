import { AggregateTracker, saveVersioned, type Track } from '@arthome-platform/transactions';
import type { EntityManager } from 'typeorm';

import { money, orderReference, type Instant, type Money, OrderState } from '@arthome/core';

import { OrderRefundRow } from './order-refund.entity.js';
import {
  SeatOrder,
  type OrderRefund,
  type SeatOrderSnapshot,
  type SeatSnapshot,
} from './seat-order.aggregate.js';
import { SeatOrderRow } from './seat-order.entity.js';
import {
  SeatOrderRepository,
  type BoundOrder,
  type IdempotencyBinding,
} from './seat-order.repository.js';
import { SeatRow } from './seat.entity.js';

export class TypeOrmSeatOrderRepository extends SeatOrderRepository {
  private readonly tracker: AggregateTracker<SeatOrder>;
  /** The seats each order held as last read or written: new ones inserted, moved ones updated. */
  private readonly storedSeats = new WeakMap<SeatOrder, ReadonlyMap<string, SeatSnapshot>>();
  /** Its refunds as last read or written: new ones inserted, those made since updated. */
  private readonly storedRefunds = new WeakMap<SeatOrder, ReadonlyMap<string, OrderRefund>>();

  public constructor(
    private readonly manager: EntityManager,
    track: Track,
  ) {
    super();
    this.tracker = new AggregateTracker(track);
  }

  public async findById(orderId: string): Promise<SeatOrder | null> {
    const row = await this.manager.findOne(SeatOrderRow, {
      where: { id: orderId },
      lock: { mode: 'pessimistic_write' },
    });
    if (row === null) return null;
    const seats = await this.manager.find(SeatRow, {
      where: { order_id: orderId },
      order: { seat_code: 'ASC' },
    });
    const refunds = await this.manager.find(OrderRefundRow, {
      where: { order_id: orderId },
      order: { owed_at: 'ASC', id: 'ASC' },
    });
    const order = SeatOrder.restore(seatOrderSnapshotOf(row, seats, refunds));
    this.storedSeats.set(order, seatsById(order.snapshot.seats));
    this.storedRefunds.set(order, refundsById(order.snapshot.refunds));
    return this.tracker.loaded(order, row.version);
  }

  public async findBound(accountId: string | null, key: string): Promise<BoundOrder | null> {
    const [bound] = await this.manager.query<{ id: string; fingerprint: string }[]>(
      `SELECT id, fingerprint FROM seat_order
        WHERE account_id IS NOT DISTINCT FROM $1 AND idempotency_key = $2`,
      [accountId, key],
    );
    return bound === undefined ? null : { orderId: bound.id, fingerprint: bound.fingerprint };
  }

  public async nextReference(placedAt: Instant): Promise<string> {
    const [next] = await this.manager.query<{ sequence: string }[]>(
      "SELECT nextval('seat_order_reference') AS sequence",
    );
    if (next === undefined) throw new Error('seat_order_reference answered no value');
    return orderReference(Number(placedAt.slice(0, 4)), Number(next.sequence));
  }

  public async place(order: SeatOrder, binding: IdempotencyBinding): Promise<boolean> {
    const current = order.snapshot;
    const { quote } = current;
    const inserted = await this.manager
      .createQueryBuilder()
      .insert()
      .into(SeatOrderRow)
      .values({
        id: current.id,
        reference: current.reference,
        idempotency_key: binding.key,
        account_id: binding.accountId,
        fingerprint: binding.fingerprint,
        date_id: current.dateId,
        channel_id: current.channelId,
        profile_id: current.profileId,
        tier: current.tier,
        quantity: current.quantity,
        currency_code: quote.total.currencyCode,
        unit_price_minor: String(quote.unitPrice.amountMinor),
        tier_total_minor: String(quote.tierTotal.amountMinor),
        service_fee_minor: String(quote.serviceFee.amountMinor),
        discount_minor: String(quote.discount.amountMinor),
        total_minor: String(quote.total.amountMinor),
        declared_tax_location: current.declaredTaxLocation,
        placed_at: new Date(current.placedAt),
        ...orderStateColumnsOf(current),
      })
      .orIgnore()
      .returning('id')
      .execute();
    if ((inserted.raw as unknown[]).length === 0) return false;
    this.storedSeats.set(order, new Map());
    this.storedRefunds.set(order, new Map());
    this.tracker.written(order, current.version);
    return true;
  }

  public async save(order: SeatOrder): Promise<void> {
    const current = order.snapshot;
    const loadedVersion = this.tracker.versionOf(order);
    if (loadedVersion === undefined) {
      throw new Error(`order ${current.id} was neither loaded nor placed in this transaction`);
    }
    await saveVersioned(
      this.manager,
      SeatOrderRow,
      { id: current.id },
      loadedVersion,
      orderStateColumnsOf(current),
      ({ version }) => ({ currentVersion: version }),
    );
    const stored = this.storedSeats.get(order) ?? new Map<string, SeatSnapshot>();
    const added = current.seats.filter(({ id }) => !stored.has(id));
    if (added.length > 0) {
      await this.manager.insert(
        SeatRow,
        added.map((seat) => seatRowOf(current, seat)),
      );
    }
    await this.saveRefunds(order);
    await this.saveMovedSeats(current, stored);
    this.storedSeats.set(order, seatsById(current.seats));
    this.tracker.written(order, current.version);
  }

  /** After the refund rows, which a seat's `refund_id` references, as a refund's seat its seat. */
  private async saveMovedSeats(
    order: SeatOrderSnapshot,
    stored: ReadonlyMap<string, SeatSnapshot>,
  ): Promise<void> {
    for (const seat of order.seats) {
      const before = stored.get(seat.id);
      if (before === undefined) continue;
      const columns = seatStateColumnsOf(seat);
      if (JSON.stringify(columns) === JSON.stringify(seatStateColumnsOf(before))) continue;
      await this.manager.update(SeatRow, { id: seat.id }, columns);
    }
  }

  /** After the order's row, under its lock: an order before its refund rows (HANDOVER §0m). */
  private async saveRefunds(order: SeatOrder): Promise<void> {
    const current = order.snapshot;
    const stored = this.storedRefunds.get(order) ?? new Map<string, OrderRefund>();
    const added = current.refunds.filter(({ id }) => !stored.has(id));
    if (added.length > 0) await this.insertRefunds(current.id, added);
    for (const refund of current.refunds) {
      const before = stored.get(refund.id);
      if (
        before === undefined ||
        (before.refundedAt === refund.refundedAt && before.ref === refund.ref)
      ) {
        continue;
      }
      await this.manager.update(
        OrderRefundRow,
        { id: refund.id },
        { refund_ref: refund.ref, refunded_at: dateOf(refund.refundedAt) },
      );
    }
    this.storedRefunds.set(order, refundsById(current.refunds));
  }

  /**
   * `ON CONFLICT DO NOTHING`, never a 23505 that would abort the caller's transaction: a row
   *   already there is the same refund, kept, or another one holding its id or key, refused.
   */
  private async insertRefunds(orderId: string, refunds: readonly OrderRefund[]): Promise<void> {
    const inserted = await this.manager
      .createQueryBuilder()
      .insert()
      .into(OrderRefundRow)
      .values(refunds.map((refund) => refundRowOf(orderId, refund)))
      .orIgnore()
      .returning('id')
      .execute();
    const insertedIds = new Set((inserted.raw as { id: string }[]).map(({ id }) => id));
    for (const refund of refunds.filter(({ id }) => !insertedIds.has(id))) {
      const held = await this.manager.findOneBy(OrderRefundRow, { id: refund.id });
      const same =
        held?.order_id === orderId &&
        held.idempotency_key === refund.idempotencyKey &&
        held.amount_minor === String(refund.amount.amountMinor);
      if (!same) {
        throw new Error(
          `refund ${refund.id} of order ${orderId} not recorded: its id or its key ` +
            `${refund.idempotencyKey} is another refund's`,
        );
      }
    }
  }
}

function seatsById(seats: readonly SeatSnapshot[]): ReadonlyMap<string, SeatSnapshot> {
  return new Map(seats.map((seat) => [seat.id, seat]));
}

function refundsById(refunds: readonly OrderRefund[]): ReadonlyMap<string, OrderRefund> {
  return new Map(refunds.map((refund) => [refund.id, refund]));
}

const dateOf = (instant: Instant | null): Date | null =>
  instant === null ? null : new Date(instant);

const instantOf = (date: Date | null): Instant | null => date?.toISOString() ?? null;

/** Every column a save may move; the rest are the placement's, written once. */
function orderStateColumnsOf(order: SeatOrderSnapshot) {
  return {
    hold_id: order.holdId,
    expires_at: new Date(order.expiresAt),
    state: order.state,
    payment_intent_ref: order.intent?.ref ?? null,
    client_secret: order.intent?.clientSecret ?? null,
    next_action: order.intent?.nextAction ?? null,
    failure_code: order.failure?.code ?? null,
    decline_code: order.failure?.declineCode ?? null,
    intent_cancel_owed_at: dateOf(order.intentCancelOwedAt),
    paid_at: dateOf(order.paidAt),
    version: order.version,
  };
}

function seatRowOf(order: SeatOrderSnapshot, seat: SeatSnapshot): Omit<SeatRow, 'created_at'> {
  return {
    id: seat.id,
    order_id: order.id,
    date_id: order.dateId,
    account_id: order.accountId,
    profile_id: order.profileId,
    tier: seat.tier,
    seat_code: seat.code,
    cancel_deadline: dateOf(seat.cancelDeadline),
    activated_at: new Date(seat.activatedAt),
    ...seatStateColumnsOf(seat),
  };
}

/** Every column a seat's move writes; the rest are its payment's, written once. */
function seatStateColumnsOf(seat: SeatSnapshot) {
  return {
    state: seat.state,
    ended_at: dateOf(seat.endedAt),
    cancel_reason: seat.cancelReason,
    refund_id: seat.refundId,
    refund_amount_minor: minorOf(seat.refundAmount),
    credit_id: seat.creditId,
    credit_amount_minor: minorOf(seat.creditAmount),
  };
}

const minorOf = (amount: Money | null): string | null =>
  amount === null ? null : String(amount.amountMinor);

function refundRowOf(
  orderId: string,
  refund: OrderRefund,
): Omit<
  OrderRefundRow,
  'traceparent' | 'enqueued_at' | 'rerun_asked_at' | 'dead_at' | 'created_at'
> {
  return {
    id: refund.id,
    order_id: orderId,
    seat_id: refund.seatId,
    amount_minor: String(refund.amount.amountMinor),
    currency_code: refund.amount.currencyCode,
    reason: refund.reason,
    idempotency_key: refund.idempotencyKey,
    owed_at: new Date(refund.owedAt),
    refund_ref: refund.ref,
    refunded_at: dateOf(refund.refundedAt),
  };
}

function refundOf(row: OrderRefundRow): OrderRefund {
  return {
    id: row.id,
    amount: money(Number(row.amount_minor), row.currency_code),
    reason: row.reason,
    idempotencyKey: row.idempotency_key,
    seatId: row.seat_id,
    owedAt: row.owed_at.toISOString(),
    ref: row.refund_ref,
    refundedAt: instantOf(row.refunded_at),
  };
}

export function seatSnapshotOf(row: SeatRow, currencyCode: string): SeatSnapshot {
  const amount = (minor: string | null) =>
    minor === null ? null : money(Number(minor), currencyCode);
  return {
    id: row.id,
    code: row.seat_code,
    tier: row.tier,
    state: row.state,
    cancelDeadline: instantOf(row.cancel_deadline),
    activatedAt: row.activated_at.toISOString(),
    endedAt: instantOf(row.ended_at),
    cancelReason: row.cancel_reason,
    refundId: row.refund_id,
    refundAmount: amount(row.refund_amount_minor),
    creditId: row.credit_id,
    creditAmount: amount(row.credit_amount_minor),
  };
}

export function seatOrderSnapshotOf(
  row: SeatOrderRow,
  seats: readonly SeatRow[],
  refunds: readonly OrderRefundRow[],
): SeatOrderSnapshot {
  const amount = (minor: string) => money(Number(minor), row.currency_code);
  return {
    id: row.id,
    reference: row.reference,
    dateId: row.date_id,
    channelId: row.channel_id,
    accountId: row.account_id,
    profileId: row.profile_id,
    tier: row.tier,
    quantity: row.quantity,
    quote: {
      unitPrice: amount(row.unit_price_minor),
      tierTotal: amount(row.tier_total_minor),
      serviceFee: amount(row.service_fee_minor),
      discount: amount(row.discount_minor),
      total: amount(row.total_minor),
    },
    declaredTaxLocation: row.declared_tax_location,
    holdId: row.hold_id,
    expiresAt: row.expires_at.toISOString(),
    state: row.state,
    intent:
      row.payment_intent_ref === null
        ? null
        : {
            ref: row.payment_intent_ref,
            clientSecret: row.client_secret,
            nextAction: row.next_action,
          },
    failure:
      row.state === OrderState.FAILED
        ? { code: row.failure_code, declineCode: row.decline_code }
        : null,
    refunds: refunds.map(refundOf),
    intentCancelOwedAt: instantOf(row.intent_cancel_owed_at),
    placedAt: row.placed_at.toISOString(),
    paidAt: instantOf(row.paid_at),
    seats: seats.map((seat) => seatSnapshotOf(seat, row.currency_code)),
    version: row.version,
  };
}
