import { AggregateTracker, saveVersioned, type Track } from '@arthome-platform/transactions';
import type { EntityManager } from 'typeorm';

import { money, orderReference, type Instant, OrderState } from '@arthome/core';

import { SeatOrder, type SeatOrderSnapshot, type SeatSnapshot } from './seat-order.aggregate.js';
import { SeatOrderRow } from './seat-order.entity.js';
import {
  SeatOrderRepository,
  type BoundOrder,
  type IdempotencyBinding,
} from './seat-order.repository.js';
import { SeatRow } from './seat.entity.js';

export class TypeOrmSeatOrderRepository extends SeatOrderRepository {
  private readonly tracker: AggregateTracker<SeatOrder>;
  /** The seats each order held as last read or written: only the new ones are inserted. */
  private readonly storedSeats = new WeakMap<SeatOrder, ReadonlySet<string>>();

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
    const order = SeatOrder.restore(seatOrderSnapshotOf(row, seats));
    this.storedSeats.set(order, new Set(seats.map(({ id }) => id)));
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
    this.storedSeats.set(order, new Set());
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
    const stored = this.storedSeats.get(order) ?? new Set<string>();
    const added = current.seats.filter(({ id }) => !stored.has(id));
    if (added.length > 0) {
      await this.manager.insert(
        SeatRow,
        added.map((seat) => seatRowOf(current, seat)),
      );
    }
    this.storedSeats.set(order, new Set(current.seats.map(({ id }) => id)));
    this.tracker.written(order, current.version);
  }
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
    refund_reason: order.refund?.reason ?? null,
    refund_owed_at: dateOf(order.refund?.owedAt ?? null),
    refund_ref: order.refund?.ref ?? null,
    refunded_at: dateOf(order.refund?.refundedAt ?? null),
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
    state: seat.state,
    cancel_deadline: dateOf(seat.cancelDeadline),
    activated_at: new Date(seat.activatedAt),
  };
}

export function seatSnapshotOf(row: SeatRow): SeatSnapshot {
  return {
    id: row.id,
    code: row.seat_code,
    tier: row.tier,
    state: row.state,
    cancelDeadline: instantOf(row.cancel_deadline),
    activatedAt: row.activated_at.toISOString(),
  };
}

export function seatOrderSnapshotOf(
  row: SeatOrderRow,
  seats: readonly SeatRow[],
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
    refund:
      row.refund_reason === null || row.refund_owed_at === null
        ? null
        : {
            reason: row.refund_reason,
            owedAt: row.refund_owed_at.toISOString(),
            ref: row.refund_ref,
            refundedAt: instantOf(row.refunded_at),
          },
    intentCancelOwedAt: instantOf(row.intent_cancel_owed_at),
    placedAt: row.placed_at.toISOString(),
    paidAt: instantOf(row.paid_at),
    seats: seats.map(seatSnapshotOf),
    version: row.version,
  };
}
