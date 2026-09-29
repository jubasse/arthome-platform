import { MemorisedResponse } from '@arthome-platform/http-edge';
import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { v7 as uuidv7 } from 'uuid';

import { OrderErrorCode, checkoutIntentExpiry, type Clock, type Instant } from '@arthome/core';

import { OrderState, SeatHoldOrigin } from './commerce-vocabulary.js';
import { failUnpaidOrder } from './fail-unpaid-order.js';
import { handoffOf, orderViewOf, ticketViewsOf } from './order-views.js';
import { interimPaymentReturnUrlOf } from './payment-return-url.js';
import { storeAnswer, storedAnswerOf, type StoredAnswer } from './purchase-answers.js';
import {
  KEY_HOLDER_WAIT_MS,
  keyInFlight,
  keyReused,
  lateEntryUnacknowledged,
  paymentUnavailable,
  priceStale,
  refusalOfUnpaid,
  soldOut,
} from './purchase-refusals.js';
import { PurchaseSeat, PurchaseStatus, type PurchaseAnswer } from './purchase-seat.command.js';
import { SeatHold } from './seat-hold.aggregate.js';
import { writeSeatOrderIntegrationEvents } from './seat-order-integration-events.js';
import { SeatOrder } from './seat-order.aggregate.js';
import { settleConfirmedPayment, type PendingCounterMove } from './settle-payment.js';
import { CLOCK } from '../clock.js';
import { OwedRefunds } from '../payments/owed-refunds.js';
import {
  IntentStatus,
  PaymentPort,
  PaymentProviderUnavailable,
  type PaymentIntent,
  type PaymentIntentRequest,
} from '../payments/payment.port.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { TicketingTransactions, type TicketingTransaction } from '../ticketing-transactions.js';

const LOCK_NOT_AVAILABLE = '55P03';

/** Another purchase committed an order under the key while this one waited to insert its own. */
class KeyBoundMeanwhile extends Error {}

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
 * adr-ticketing.md §2. Tx A binds the key to a new order, verifies the price, takes the seats with
 *   the one conditional decrement and places the hold; the provider is called outside any
 *   transaction, keyed by the order id; tx B records what it said and, confirmed, pays the order.
 *   The key is the order's (a unique `seat_order.idempotency_key`), so a replay finds the order:
 *   answered, it serves the first answer again; interrupted between A and B, it resumes where the
 *   order stands, the provider handing back the intent it already created. A refusal of tx A
 *   rolls the order back with everything else, so the key stays free.
 */
@CommandHandler(PurchaseSeat)
export class PurchaseSeatHandler implements ICommandHandler<PurchaseSeat> {
  private readonly logger = new Logger(PurchaseSeatHandler.name);

  public constructor(
    private readonly transactions: TicketingTransactions,
    private readonly payments: PaymentPort,
    private readonly refunds: OwedRefunds,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUBLIC_WEB_ORIGIN) private readonly publicWebOrigin: string,
  ) {}

  public async execute(command: PurchaseSeat): Promise<PurchaseAnswer> {
    const placement = await this.placeOrFind(command);
    const { orderId } = placement;
    const resumption: Resumption =
      placement.kind === 'placed'
        ? { kind: 'create_intent', request: placement.request }
        : await this.transactions.run((transaction) =>
            this.resumeIn(transaction, orderId, command),
          );
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
    if (recorded.kind === 'refusal') {
      await this.refundIfOwed(orderId);
      throw recorded.refusal;
    }
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
    { manager, orders, holds, dateSales }: TicketingTransaction,
    { body, idempotency, traceparent }: PurchaseSeat,
  ): Promise<Placement> {
    const bound = await orders.findBound(idempotency.accountId, idempotency.key);
    if (bound !== null) {
      if (bound.fingerprint !== idempotency.fingerprint) throw keyReused();
      return { kind: 'bound', orderId: bound.orderId };
    }

    const now = this.clock.now();
    const sales = await dateSales.findUnlocked(body.dateId);
    if (sales?.sellsSeatsAt(now) !== true) throw soldOut();
    const lateEntry = sales.lateEntryAt(now);
    if (lateEntry !== null && body.acknowledgeLateEntry !== true) {
      throw lateEntryUnacknowledged(lateEntry);
    }
    const quote = sales.quote(body.tier, body.quantity);
    const { expectedTotal } = body;
    if (
      quote?.total.amountMinor !== expectedTotal.amountMinor ||
      quote.total.currencyCode !== expectedTotal.currencyCode
    ) {
      throw priceStale(expectedTotal, quote?.total ?? null);
    }

    const orderId = uuidv7();
    const holdId = uuidv7();
    const expiresAt = checkoutIntentExpiry(now);
    const buyer = { accountId: idempotency.accountId, profileId: body.profileId ?? null };
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
    sales.holdSeats(body.quantity, now);
    if (!(await dateSales.takeSeats(sales, body.quantity, now))) throw soldOut();
    return { kind: 'placed', orderId, request: this.intentRequestOf(order) };
  }

  /**
   * The insert waits for a purchase holding the same key until it commits or rolls back, bounded:
   *   past `KEY_HOLDER_WAIT_MS` the caller is told the first is in flight, and retries.
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

  private async resumeIn(
    transaction: TicketingTransaction,
    orderId: string,
    { traceparent }: PurchaseSeat,
  ): Promise<Resumption> {
    const { manager, orders, holds } = transaction;
    const stored = await storedAnswerOf(manager, orderId);
    if (stored !== null) return this.answered(stored, true);

    const order = await this.loadOrder(transaction, orderId);
    if (order.awaitsClientSecret) {
      return { kind: 'create_intent', request: this.intentRequestOf(order) };
    }
    if (!order.awaitsIntent) return this.answerOf(transaction, order);

    const now = this.clock.now();
    const hold = await holds.findById(order.snapshot.holdId);
    if (hold?.isActive !== true) {
      const renewed = await this.renewHoldIn(transaction, order, now);
      await orders.save(order);
      await writeSeatOrderIntegrationEvents(manager, order.getUncommittedEvents(), {
        traceparent,
      });
      if (!renewed) return { kind: 'refusal', refusal: soldOut() };
    }
    return { kind: 'create_intent', request: this.intentRequestOf(order) };
  }

  private intentRequestOf(order: SeatOrder): PaymentIntentRequest {
    const { id, quote, expiresAt } = order.snapshot;
    return {
      orderId: id,
      amount: quote.total,
      expiresAt,
      returnUrl: interimPaymentReturnUrlOf(this.publicWebOrigin, id),
    };
  }

  /**
   * An order whose hold was given back while the provider did not answer takes its seats again
   *   before its intent is created; with none left, it fails sold out.
   */
  private async renewHoldIn(
    { holds, dateSales }: TicketingTransaction,
    order: SeatOrder,
    now: Instant,
  ): Promise<boolean> {
    const { id, dateId, accountId, profileId, tier, quantity } = order.snapshot;
    const sales = await dateSales.findUnlocked(dateId);
    if (sales !== null) sales.holdSeats(quantity, now);
    if (sales === null || !(await dateSales.takeSeats(sales, quantity, now))) {
      order.fail({ code: OrderErrorCode.SOLD_OUT, declineCode: null }, now);
      return false;
    }
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
    return true;
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
        order.recordIntent(record, OrderState.AWAITING_ACTION, now);
        break;
      case IntentStatus.PROCESSING:
        order.recordIntent(record, OrderState.PROCESSING, now);
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

  /**
   * A confirmation with no seat left to take (D-082), refunded at once; the payment worker asks
   *   again should the provider not answer now.
   */
  private async refundIfOwed(orderId: string): Promise<void> {
    try {
      await this.refunds.refund(orderId);
    } catch (error) {
      this.logger.error(
        `refund owed by order ${orderId} not made yet`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** The provider did not answer: the hold goes back (adr-ticketing.md §12), the order waits. */
  private async releaseHoldOf(transaction: TicketingTransaction, orderId: string): Promise<void> {
    const { holds, dateSales } = transaction;
    const order = await this.loadOrder(transaction, orderId);
    if (!order.awaitsIntent) return;
    const hold = await holds.findById(order.snapshot.holdId);
    if (hold?.isActive !== true) return;
    hold.release(this.clock.now());
    await holds.save(hold);
    await dateSales.returnHeldSeats(hold.snapshot.dateId, hold.snapshot.quantity);
  }

  /** The first answer the order gives, kept for its replays; a refusal is answered from its state. */
  private async answerOf({ manager }: TicketingTransaction, order: SeatOrder): Promise<Resumption> {
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
      : handoffOf(snapshot, interimPaymentReturnUrlOf(this.publicWebOrigin, snapshot.id));
    if (handoff !== null) {
      return this.kept(manager, snapshot.id, {
        status: PurchaseStatus.AWAITING_PAYMENT,
        envelope: { servedAt: this.clock.now(), data: handoff },
      });
    }
    return { kind: 'refusal', refusal: refusalOfUnpaid(snapshot) };
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
