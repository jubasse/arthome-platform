import { MemorisedResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { v7 as uuidv7 } from 'uuid';

import {
  OrderErrorCode,
  checkoutIntentExpiry,
  type Clock,
  type Instant,
  OrderState,
  SeatHoldOrigin,
  salesEndedBy,
  paymentReturnPath,
  IntentStatus,
  type PaymentPort,
  PaymentProviderUnavailable,
  type PaymentIntent,
  type PaymentIntentRequest,
} from '@arthome/core';

import { failUnpaidOrder } from './fail-unpaid-order.js';
import { handoffOf, orderViewOf, ticketViewsOf } from './order-views.js';
import { storeAnswer, storedAnswerOf, type StoredAnswer } from './purchase-answers.js';
import {
  KEY_HOLDER_WAIT_MS,
  keyInFlight,
  keyReused,
  lateEntryUnacknowledged,
  paymentUnavailable,
  priceStale,
  refusalOfUnpaid,
  salesClosed,
  soldOut,
  tierUnavailable,
} from './purchase-refusals.js';
import { PurchaseSeat, PurchaseStatus, type PurchaseAnswer } from './purchase-seat.command.js';
import { recordWaitingIntent } from './record-waiting-intent.js';
import { SeatHold } from './seat-hold.aggregate.js';
import { writeSeatOrderIntegrationEvents } from './seat-order-integration-events.js';
import { SeatOrder } from './seat-order.aggregate.js';
import { settleConfirmedPayment, type PendingCounterMove } from './settle-payment.js';
import { CLOCK } from '../clock.js';
import type { DateSales } from '../date-sales/date-sales.aggregate.js';
import { PAYMENT_PORT } from '../payments/payment-tokens.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { TicketingTransactions, type TicketingTransaction } from '../ticketing-transactions.js';
import { drawsOnPriorityPool } from '../waitlist/priority-pool.js';

const LOCK_NOT_AVAILABLE = '55P03';

/** Another purchase committed an order under the key while this one waited to insert its own. */
class KeyBoundMeanwhile extends Error {}

/** A renewed hold's statement found no seat left: its transaction rolls back, the order fails after. */
class RenewalSoldOut extends Error {
  public constructor(
    public readonly orderId: string,
    public readonly staleHoldId: string,
  ) {
    super(`order ${orderId} found no seat to hold again`);
  }
}

/** A new order, its intent to create at once; or the one the key already created, to resume. */
type Placement =
  | { readonly kind: 'placed'; readonly orderId: string; readonly request: PaymentIntentRequest }
  | { readonly kind: 'bound'; readonly orderId: string };

/** Where a purchase stands once its order exists: answered, refused, or an intent to create. */
type Resumption =
  | { readonly kind: 'answered'; readonly answer: PurchaseAnswer }
  | { readonly kind: 'refusal'; readonly refusal: Error }
  | { readonly kind: 'create_intent'; readonly request: PaymentIntentRequest };

/**
 * adr-ticketing.md §2 (HANDOVER §0h): tx A binds the key to a new order and takes the seats, the
 *   provider is called outside any transaction under the order id, tx B records what it said. The
 *   key is the order's, so a replay serves the kept answer or resumes the order where it stands.
 */
@CommandHandler(PurchaseSeat)
export class PurchaseSeatHandler implements ICommandHandler<PurchaseSeat> {
  public constructor(
    private readonly transactions: TicketingTransactions,
    @Inject(PAYMENT_PORT) private readonly payments: PaymentPort,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUBLIC_WEB_ORIGIN) private readonly publicWebOrigin: string,
  ) {}

  public async execute(command: PurchaseSeat): Promise<PurchaseAnswer> {
    const placement = await this.placeOrFind(command);
    const { orderId } = placement;
    const resumption: Resumption =
      placement.kind === 'placed'
        ? { kind: 'create_intent', request: placement.request }
        : await this.resume(orderId, command);
    if (resumption.kind === 'answered') return resumption.answer;
    if (resumption.kind === 'refusal') throw resumption.refusal;

    let intent: PaymentIntent;
    try {
      intent = await this.payments.createIntent(resumption.request);
    } catch (error) {
      if (!(error instanceof PaymentProviderUnavailable)) throw error;
      await this.transactions.run((transaction) => this.releaseHoldOf(transaction, orderId));
      throw paymentUnavailable(error);
    }
    const recorded = await this.transactions.run((transaction) =>
      this.recordIntentIn(transaction, orderId, intent, command),
    );
    if (recorded.kind === 'refusal') throw recorded.refusal;
    if (recorded.kind === 'create_intent') throw new Error(`order ${orderId} lost its intent`);
    return recorded.answer;
  }

  /** The order the key created, placed now in tx A when none was. */
  private async placeOrFind(command: PurchaseSeat): Promise<Placement> {
    try {
      return await this.transactions.run((transaction) => this.placeIn(transaction, command));
    } catch (error) {
      if (!(error instanceof KeyBoundMeanwhile)) throw error;
      return this.transactions.run((transaction) => this.placeIn(transaction, command));
    }
  }

  private async placeIn(
    transaction: TicketingTransaction,
    { body, buyer, idempotency, traceparent, lateEntryAcknowledged }: PurchaseSeat,
  ): Promise<Placement> {
    const { manager, orders, holds, dateSales } = transaction;
    const bound = await orders.findBound(idempotency.accountId, idempotency.key);
    if (bound !== null) {
      if (bound.fingerprint !== idempotency.fingerprint) throw keyReused();
      return { kind: 'bound', orderId: bound.orderId };
    }

    const now = this.clock.now();
    const sales = await dateSales.findUnlocked(body.dateId);
    if (sales === null) throw soldOut();
    // Its decision first, its statement last: past the end or off sale, refused before the key.
    sales.holdSeats(body.quantity, now);
    const lateEntry = sales.lateEntryAt(now);
    if (lateEntry !== null && !lateEntryAcknowledged) throw lateEntryUnacknowledged(lateEntry);
    const quote = sales.quote(body.tier, body.quantity);
    const { expectedTotal } = body;
    if (quote === null) throw tierUnavailable();
    if (
      quote.total.amountMinor !== expectedTotal.amountMinor ||
      quote.total.currencyCode !== expectedTotal.currencyCode
    ) {
      throw priceStale(expectedTotal, quote.total);
    }
    const fromPool = await drawsOnPriorityPool(transaction, sales, buyer.accountId, now);

    const orderId = uuidv7();
    const holdId = uuidv7();
    const expiresAt = checkoutIntentExpiry(now);
    const hold = SeatHold.place(
      {
        id: holdId,
        dateId: body.dateId,
        ...buyer,
        tier: body.tier,
        quantity: body.quantity,
        origin: SeatHoldOrigin.CHECKOUT,
        originRef: orderId,
        intentExpiresAt: expiresAt,
      },
      now,
    );
    const order = SeatOrder.place(
      {
        id: orderId,
        reference: await orders.nextReference(now),
        dateId: body.dateId,
        channelId: sales.snapshot.channelId,
        ...buyer,
        tier: body.tier,
        quantity: body.quantity,
        quote,
        declaredTaxLocation:
          body.declaredTaxLocation == null
            ? null
            : {
                country: body.declaredTaxLocation.country,
                subdivision: body.declaredTaxLocation.subdivision ?? null,
                postalCode: body.declaredTaxLocation.postalCode ?? null,
              },
        holdId,
        expiresAt,
      },
      now,
    );

    if (!(await this.bindKey(manager, () => orders.place(order, idempotency)))) {
      throw new KeyBoundMeanwhile();
    }
    await holds.save(hold);
    await writeSeatOrderIntegrationEvents(manager, order.getUncommittedEvents(), { traceparent });
    // Last, so the date's row is locked for the commit alone. The hold's foreign key takes a KEY
    //   SHARE on it, which the decrement's NO KEY UPDATE does not wait on.
    const taken = fromPool
      ? await dateSales.takeSeatsFromPool(sales, holdId, body.quantity, now)
      : await dateSales.takeSeats(sales, body.quantity, now);
    if (!taken) throw soldOut();
    return { kind: 'placed', orderId, request: this.intentRequestOf(order) };
  }

  /**
   * The insert waits for a purchase holding the same key until it commits or rolls back, bounded:
   *   past `KEY_HOLDER_WAIT_MS` the caller is told the first is in flight, and retries. The bound
   *   also covers the order's foreign key waiting on a studio command's lock of the date, which is
   *   then answered in flight too: a retry a second later is the right answer to both.
   */
  private async bindKey(
    manager: TicketingTransaction['manager'],
    place: () => Promise<boolean>,
  ): Promise<boolean> {
    await manager.query(`SET LOCAL lock_timeout = ${String(KEY_HOLDER_WAIT_MS)}`);
    let placed: boolean;
    try {
      placed = await place();
    } catch (error) {
      if (postgresCodeOf(error) === LOCK_NOT_AVAILABLE) throw keyInFlight();
      throw error;
    }
    await manager.query('SET LOCAL lock_timeout = DEFAULT');
    return placed;
  }

  private async resume(orderId: string, command: PurchaseSeat): Promise<Resumption> {
    try {
      return await this.transactions.run((transaction) =>
        this.resumeIn(transaction, orderId, command),
      );
    } catch (error) {
      if (!(error instanceof RenewalSoldOut)) throw error;
      return this.transactions.run((transaction) =>
        this.failSoldOutIn(transaction, error, command.traceparent),
      );
    }
  }

  private async resumeIn(
    transaction: TicketingTransaction,
    orderId: string,
    { traceparent, lateEntryAcknowledged }: PurchaseSeat,
  ): Promise<Resumption> {
    const { manager, holds, dateSales } = transaction;
    const stored = await storedAnswerOf(manager, orderId);
    if (stored !== null) return this.answered(stored, true);

    const order = await this.loadOrder(transaction, orderId);
    if (!order.awaitsClientSecret && !order.awaitsIntent) return this.answerOf(transaction, order);

    const now = this.clock.now();
    const sales = await dateSales.findUnlocked(order.snapshot.dateId);
    const holdGone =
      !order.awaitsClientSecret && (await holds.findById(order.snapshot.holdId))?.isActive !== true;
    // Seats to take again past the end: closed, as a new purchase is, before it is asked anything.
    const salesEndAt = sales?.snapshot.salesEndAt ?? null;
    if (holdGone && salesEndAt !== null && salesEndedBy(salesEndAt, now)) {
      order.fail({ code: OrderErrorCode.SALES_CLOSED, declineCode: null }, now);
      await this.saveResumed(transaction, order, traceparent);
      return { kind: 'refusal', refusal: salesClosed(salesEndAt) };
    }
    // A purchase that goes on to the provider after the start is asked like a new one (D-089): the
    //   acknowledgement is a header, outside the key's fingerprint, so a retry can carry it.
    const lateEntry = sales?.lateEntryAt(now) ?? null;
    if (lateEntry !== null && !lateEntryAcknowledged) {
      return { kind: 'refusal', refusal: lateEntryUnacknowledged(lateEntry) };
    }
    if (holdGone) {
      const staleHoldId = order.snapshot.holdId;
      const takeSeats = await this.renewHoldIn(transaction, order, sales, now);
      await this.saveResumed(transaction, order, traceparent);
      if (takeSeats === null) return { kind: 'refusal', refusal: soldOut() };
      // Last, as tx A's: every buyer retries at once after an outage. None left, the new hold and
      //   the order's renewal roll back with it.
      if (!(await takeSeats())) throw new RenewalSoldOut(orderId, staleHoldId);
    }
    return { kind: 'create_intent', request: this.intentRequestOf(order) };
  }

  /**
   * After a renewal rolled back for want of seats: the order fails sold out, unless another attempt
   *   under its key renewed it meanwhile and answers for it.
   */
  private async failSoldOutIn(
    transaction: TicketingTransaction,
    { orderId, staleHoldId }: RenewalSoldOut,
    traceparent: string | null,
  ): Promise<Resumption> {
    const order = await this.loadOrder(transaction, orderId);
    if (order.snapshot.holdId !== staleHoldId) return { kind: 'refusal', refusal: keyInFlight() };
    if (!order.awaitsIntent) return this.answerOf(transaction, order);
    order.fail({ code: OrderErrorCode.SOLD_OUT, declineCode: null }, this.clock.now());
    await this.saveResumed(transaction, order, traceparent);
    return { kind: 'refusal', refusal: soldOut() };
  }

  private async saveResumed(
    { manager, orders }: TicketingTransaction,
    order: SeatOrder,
    traceparent: string | null,
  ): Promise<void> {
    await orders.save(order);
    await writeSeatOrderIntegrationEvents(manager, order.getUncommittedEvents(), { traceparent });
  }

  private intentRequestOf(order: SeatOrder): PaymentIntentRequest {
    const { id, quote, expiresAt } = order.snapshot;
    return {
      orderId: id,
      amount: quote.total,
      expiresAt,
      returnUrl: `${this.publicWebOrigin}${paymentReturnPath(id)}`,
    };
  }

  /**
   * An order whose hold was given back while the provider did not answer holds its seats again
   *   before its intent is created: a new hold, the order moved to it, and the statement that takes
   *   the seats handed back for the caller to run last. Null, the order failed sold out, when the
   *   sale no longer sells.
   */
  private async renewHoldIn(
    transaction: TicketingTransaction,
    order: SeatOrder,
    sales: DateSales | null,
    now: Instant,
  ): Promise<(() => Promise<boolean>) | null> {
    const { holds, dateSales } = transaction;
    const { id, dateId, accountId, profileId, tier, quantity } = order.snapshot;
    if (sales?.sellsSeatsAt(now) !== true) {
      order.fail({ code: OrderErrorCode.SOLD_OUT, declineCode: null }, now);
      return null;
    }
    sales.holdSeats(quantity, now);
    const fromPool = await drawsOnPriorityPool(transaction, sales, accountId, now);
    const expiresAt = checkoutIntentExpiry(now);
    const hold = SeatHold.place(
      {
        id: uuidv7(),
        dateId,
        accountId,
        profileId,
        tier,
        quantity,
        origin: SeatHoldOrigin.CHECKOUT,
        originRef: id,
        intentExpiresAt: expiresAt,
      },
      now,
    );
    await holds.save(hold);
    order.renewHold(hold.snapshot.id, expiresAt, now);
    return fromPool
      ? () => dateSales.takeSeatsFromPool(sales, hold.snapshot.id, quantity, now)
      : () => dateSales.takeSeats(sales, quantity, now);
  }

  /**
   * Tx B: what the provider said, applied forward only, then the purchase's answer; the date's
   *   counters move last, so its row is locked for the commit alone.
   */
  private async recordIntentIn(
    transaction: TicketingTransaction,
    orderId: string,
    intent: PaymentIntent,
    { traceparent }: PurchaseSeat,
  ): Promise<Resumption> {
    const { manager, orders } = transaction;
    const order = await this.loadOrder(transaction, orderId);
    const now = this.clock.now();
    const record = {
      ref: intent.ref,
      clientSecret: intent.clientSecret,
      nextAction: intent.nextAction,
    };
    let pending: PendingCounterMove | null = null;
    switch (intent.status) {
      case IntentStatus.SUCCEEDED:
        pending = await settleConfirmedPayment(transaction, order, intent.ref, now, traceparent);
        break;
      case IntentStatus.REQUIRES_ACTION:
        await recordWaitingIntent(transaction, order, record, OrderState.AWAITING_ACTION, now);
        break;
      case IntentStatus.PROCESSING:
        await recordWaitingIntent(transaction, order, record, OrderState.PROCESSING, now);
        break;
      case IntentStatus.DECLINED:
        pending = await failUnpaidOrder(
          transaction,
          order,
          { code: OrderErrorCode.PAYMENT_DECLINED, declineCode: intent.declineCode },
          now,
        );
        break;
    }
    await orders.save(order);
    await writeSeatOrderIntegrationEvents(manager, order.getUncommittedEvents(), { traceparent });
    const answer = await this.answerOf(transaction, order);
    await pending?.();
    return answer;
  }

  /** The provider did not answer: the hold goes back (adr-ticketing.md §12), the order waits. */
  private async releaseHoldOf(transaction: TicketingTransaction, orderId: string): Promise<void> {
    const { holds, dateSales } = transaction;
    const order = await this.loadOrder(transaction, orderId);
    if (!order.awaitsIntent) return;
    const hold = await holds.findById(order.snapshot.holdId);
    if (hold?.isActive !== true) return;
    const now = this.clock.now();
    hold.release(now);
    await holds.save(hold);
    await dateSales.returnHeldSeats(hold.snapshot.dateId, hold.snapshot, now);
  }

  /** The first answer the order gives, kept for its replays; a refusal is answered from its state. */
  private async answerOf(
    { manager, dateSales }: TicketingTransaction,
    order: SeatOrder,
  ): Promise<Resumption> {
    const snapshot = order.snapshot;
    if (snapshot.state === OrderState.PAID) {
      return this.kept(manager, snapshot.id, {
        status: PurchaseStatus.PAID,
        envelope: {
          servedAt: this.clock.now(),
          data: { tickets: ticketViewsOf(snapshot), order: orderViewOf(snapshot) },
        },
      });
    }
    const handoff = order.owesRefund
      ? null
      : handoffOf(snapshot, `${this.publicWebOrigin}${paymentReturnPath(snapshot.id)}`);
    if (handoff !== null) {
      return this.kept(manager, snapshot.id, {
        status: PurchaseStatus.AWAITING_PAYMENT,
        envelope: { servedAt: this.clock.now(), data: handoff },
      });
    }
    const sales = await dateSales.findUnlocked(snapshot.dateId);
    return {
      kind: 'refusal',
      refusal: refusalOfUnpaid(snapshot, sales?.snapshot.salesEndAt ?? null),
    };
  }

  private async kept(
    manager: TicketingTransaction['manager'],
    orderId: string,
    answer: StoredAnswer,
  ): Promise<Resumption> {
    if (await storeAnswer(manager, orderId, answer)) return this.answered(answer, false);
    const first = await storedAnswerOf(manager, orderId);
    if (first === null) throw new Error(`order ${orderId} kept no answer`);
    return this.answered(first, true);
  }

  private answered({ status, envelope }: StoredAnswer, replayed: boolean): Resumption {
    return {
      kind: 'answered',
      answer: { status, response: new MemorisedResponse(envelope, replayed) },
    };
  }

  private async loadOrder({ orders }: TicketingTransaction, orderId: string): Promise<SeatOrder> {
    const order = await orders.findById(orderId);
    if (order === null) throw new Error(`order ${orderId} vanished`);
    return order;
  }
}

function postgresCodeOf(error: unknown): string | undefined {
  const withDriver = error as { driverError?: { code?: unknown }; code?: unknown };
  const code = withDriver.driverError?.code ?? withDriver.code;
  return typeof code === 'string' ? code : undefined;
}
