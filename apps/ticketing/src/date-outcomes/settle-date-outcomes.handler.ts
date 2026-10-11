import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import {
  DateOutcome,
  HOUR_MS,
  SeatHoldState,
  SeatState,
  type Clock,
  type Instant,
} from '@arthome/core';

import { cancelledDateSettlementOf, interruptedDateSettlementOf } from './order-outcome.js';
import { SettleDateOutcomes } from './settle-date-outcomes.command.js';
import { WaitlistOutcomeHook } from './waitlist-outcome-hook.js';
import { CLOCK } from '../clock.js';
import { Credit } from '../credits/credit.aggregate.js';
import { recordCreditEvents } from '../credits/record-credit-events.js';
import { writeSeatOrderIntegrationEvents } from '../orders/seat-order-integration-events.js';
import { recordRefundTraceparent } from '../payments/refund-ledger.js';
import { TicketingTransactions, type TicketingTransaction } from '../ticketing-transactions.js';

/**
 * How long a date whose settlement failed waits before it is tried again, behind the others, as
 *   the availability publisher sets a date aside.
 */
export const DATE_OUTCOME_RETRY_SECONDS = 10;

interface Settlement {
  readonly outcome: DateOutcome;
  readonly traceparent: string | null;
  readonly waitlist_ended_at: Date | null;
}

/**
 * A date whose orders are all settled and whose waiting list has ended waits on a live hold alone:
 *   it sorts behind every date with work left, so ten of them never fill a pass while another
 *   date's refunds wait (the PT1 review's F1).
 */
export const DUE_SETTLEMENTS = `
  SELECT due.date_id, due.recorded_at FROM date_outcome_settlement AS due
   WHERE due.settled_at IS NULL AND (due.failed_at IS NULL OR due.failed_at <= $1)
   ORDER BY (due.waitlist_ended_at IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM seat
                               JOIN seat_order AS placed ON placed.id = seat.order_id
                              WHERE seat.date_id = due.date_id AND seat.state = $3
                                AND placed.outcome_settled_at IS NULL)) ASC,
            due.failed_at ASC NULLS FIRST, due.recorded_at ASC
   LIMIT $2
`;

/** Replicas share the dates: each step claims its date's row, and skips one another holds. */
export const CLAIM_SETTLEMENT = `
  SELECT outcome, traceparent, waitlist_ended_at FROM date_outcome_settlement
   WHERE date_id = $1 AND settled_at IS NULL
     FOR UPDATE SKIP LOCKED
`;

/**
 * The date's active seats through `idx_seat_date_active`, then their orders by key: as a semi-join
 *   the planner hashed it against a scan of every order ever placed (`settlement-plan.itest.ts`).
 *   An order a payment or a seat's cancellation holds is skipped, and taken by a later pass.
 */
export const ORDERS_TO_SETTLE = `
  SELECT placed.id FROM seat_order AS placed
   WHERE placed.id = ANY (ARRAY(SELECT seat.order_id FROM seat
                                 WHERE seat.date_id = $1 AND seat.state = $3))
     AND placed.outcome_settled_at IS NULL
   ORDER BY placed.id
   LIMIT $2
     FOR UPDATE OF placed SKIP LOCKED
`;

/**
 * One statement, so one snapshot: a payment through a hold active at the outcome commits its
 *   consumed hold and its seats together, and is seen as one or the other, never as neither.
 */
export const NOTHING_LEFT_TO_SETTLE = `
  SELECT NOT EXISTS (SELECT 1 FROM seat JOIN seat_order AS placed ON placed.id = seat.order_id
                      WHERE seat.date_id = $1 AND seat.state = $2
                        AND placed.outcome_settled_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM seat_hold WHERE date_id = $1 AND state = $3) AS settled
`;

/**
 * adr-ticketing.md §8's outcomes, settled from the row the consumer wrote (HANDOVER §0n): on a
 *   cancellation one refund per paid order of what is left and its seats cancelled, on an
 *   interruption one credit per paid order and its seats credited, 500 orders per transaction,
 *   each marked whatever it gave. The waiting list ends once, through `WaitlistOutcomeHook`. A date
 *   stays in the pass until no order holds an active seat unsettled and no hold is active, since a
 *   hold active at the outcome may still be paid. It calls no provider (the refunds are rows the
 *   worker makes) and never locks `date_sales`, whose counters a closed sale no longer moves.
 */
@CommandHandler(SettleDateOutcomes)
export class SettleDateOutcomesHandler implements ICommandHandler<SettleDateOutcomes> {
  private readonly logger = new Logger(SettleDateOutcomesHandler.name);

  public constructor(
    private readonly transactions: TicketingTransactions,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly waitlist: WaitlistOutcomeHook,
  ) {}

  public async execute({ orderBatch, dates }: SettleDateOutcomes): Promise<number> {
    const now = this.clock.now();
    const retrySince = new Date(Date.parse(now) - DATE_OUTCOME_RETRY_SECONDS * 1_000);
    const due = await this.dataSource.query<{ date_id: string; recorded_at: Date }[]>(
      DUE_SETTLEMENTS,
      [retrySince, dates, SeatState.ACTIVE],
    );
    let settled = 0;
    for (const { date_id, recorded_at } of due) {
      try {
        settled += await this.settleDate(date_id, orderBatch, now);
      } catch (error) {
        // One date that cannot be settled must not hold back the others.
        await this.setAside(date_id, recorded_at, now, error);
      }
    }
    return settled;
  }

  /** Money first: a waiting list that cannot end holds no refund back. */
  private async settleDate(dateId: string, orderBatch: number, now: Instant): Promise<number> {
    const batch = await this.settleOrders(dateId, orderBatch, now);
    if (batch === null) return 0;
    if (!batch.waitlistEnded) await this.endWaitlist(dateId, now);
    return batch.orders;
  }

  /** Null when another replica holds the date. */
  private settleOrders(
    dateId: string,
    orderBatch: number,
    now: Instant,
  ): Promise<{ orders: number; waitlistEnded: boolean } | null> {
    return this.transactions.run(async (transaction) => {
      const { manager } = transaction;
      const settlement = await claimSettlement(manager, dateId);
      if (settlement === null) return null;
      const orderIds = (
        await manager.query<{ id: string }[]>(ORDERS_TO_SETTLE, [
          dateId,
          orderBatch,
          SeatState.ACTIVE,
        ])
      ).map(({ id }) => id);
      for (const orderId of orderIds) {
        await this.settleOrder(transaction, dateId, settlement, orderId, now);
      }
      if (orderIds.length > 0) {
        await manager.query(
          'UPDATE seat_order SET outcome_settled_at = $2 WHERE id = ANY($1::uuid[])',
          [orderIds, new Date(now)],
        );
      }
      const waitlistEnded = settlement.waitlist_ended_at !== null;
      const settled =
        orderIds.length < orderBatch &&
        waitlistEnded &&
        (await nothingLeftToSettle(manager, dateId));
      await manager.query(
        `UPDATE date_outcome_settlement SET failed_at = NULL, settled_at = $2
          WHERE date_id = $1`,
        [dateId, settled ? new Date(now) : null],
      );
      return { orders: orderIds.length, waitlistEnded };
    });
  }

  /** The order under the batch's lock, then its seats, refund rows and credit (HANDOVER §0n). */
  private async settleOrder(
    { manager, orders, credits }: TicketingTransaction,
    dateId: string,
    { outcome, traceparent }: Settlement,
    orderId: string,
    now: Instant,
  ): Promise<void> {
    const order = await orders.findById(orderId);
    if (order === null) throw new Error(`order ${orderId} of date ${dateId} vanished`);
    if (outcome === DateOutcome.CANCELLED) {
      const settled = cancelledDateSettlementOf(order, uuidv7());
      if (settled === null) return;
      if (settled.refund !== null) order.oweRefund(settled.refund, now);
      order.cancelSeats(settled.cancellation, now);
      await orders.save(order);
      if (settled.refund !== null) {
        await recordRefundTraceparent(manager, settled.refund.id, traceparent);
      }
    } else {
      const settled = interruptedDateSettlementOf(order, uuidv7());
      if (settled.kind === 'nothing_owed') {
        if (settled.because === 'no_account') {
          this.logger.warn(
            `order ${orderId} of interrupted date ${dateId} has no account: no credit issued`,
          );
        }
        return;
      }
      const credit = Credit.issue(settled.credit, now);
      if (!(await credits.issue(credit))) {
        this.logger.warn(`order ${orderId} of interrupted date ${dateId} was credited already`);
        return;
      }
      order.creditSeats(settled.crediting, now);
      await orders.save(order);
      await recordCreditEvents(manager, credit.getUncommittedEvents(), traceparent);
    }
    await writeSeatOrderIntegrationEvents(manager, order.getUncommittedEvents(), { traceparent });
  }

  /** D-096, once, in a transaction of its own; settled by a later pass once it has ended. */
  private endWaitlist(dateId: string, now: Instant): Promise<void> {
    return this.transactions.run(async (transaction) => {
      const settlement = await claimSettlement(transaction.manager, dateId);
      if (settlement?.waitlist_ended_at !== null) return;
      await this.waitlist.endWaitlist(transaction, dateId, now);
      await transaction.manager.query(
        'UPDATE date_outcome_settlement SET waitlist_ended_at = $2 WHERE date_id = $1',
        [dateId, new Date(now)],
      );
    });
  }

  private async setAside(
    dateId: string,
    recordedAt: Date,
    now: Instant,
    error: unknown,
  ): Promise<void> {
    const failure = error instanceof Error ? error.stack : String(error);
    const message = `outcome of date ${dateId} not settled, tried again in ${String(DATE_OUTCOME_RETRY_SECONDS)} s`;
    if (Date.parse(now) - recordedAt.getTime() > HOUR_MS) {
      this.logger.error(
        `${message}; its outcome was recorded at ${recordedAt.toISOString()}, over an hour ago`,
        failure,
      );
    } else {
      this.logger.warn(`${message}: ${String(failure)}`);
    }
    await this.dataSource.query(
      'UPDATE date_outcome_settlement SET failed_at = $2 WHERE date_id = $1',
      [dateId, new Date(now)],
    );
  }
}

async function claimSettlement(manager: EntityManager, dateId: string): Promise<Settlement | null> {
  const [settlement] = await manager.query<Settlement[]>(CLAIM_SETTLEMENT, [dateId]);
  return settlement ?? null;
}

async function nothingLeftToSettle(manager: EntityManager, dateId: string): Promise<boolean> {
  const [check] = await manager.query<{ settled: boolean }[]>(NOTHING_LEFT_TO_SETTLE, [
    dateId,
    SeatState.ACTIVE,
    SeatHoldState.ACTIVE,
  ]);
  return check?.settled === true;
}
