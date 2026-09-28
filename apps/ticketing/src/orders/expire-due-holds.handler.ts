import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import type { EntityManager } from 'typeorm';

import type { Clock } from '@arthome/core';

import { OrderState, SeatHoldState } from './commerce-vocabulary.js';
import { ExpireDueHolds } from './expire-due-holds.command.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

interface DueHold {
  readonly hold_id: string;
  readonly order_id: string;
  readonly date_id: string;
  readonly quantity: number;
}

const AWAITING_PAYMENT = [OrderState.PENDING, OrderState.AWAITING_ACTION, OrderState.PROCESSING];

/**
 * adr-ticketing.md §6, set-based: a pass takes the expired active holds with their orders, both
 *   `FOR UPDATE SKIP LOCKED`, so a hold whose order a payment holds is left to that payment, and
 *   this pass never waits on a lock a payment could be waiting behind. Each hold is `expired`, its
 *   order `failed` (owing the cancellation of an intent it holds), and its seats go back, one
 *   statement per date in `date_id` order, the dates' rows last. The database is the truth: a
 *   pass missed or crashed leaves them due for the next one.
 */
@CommandHandler(ExpireDueHolds)
export class ExpireDueHoldsHandler implements ICommandHandler<ExpireDueHolds> {
  public constructor(
    private readonly transactions: TicketingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute({ batch }: ExpireDueHolds): Promise<number> {
    return this.transactions.run(async ({ manager, dateSales }) => {
      const now = new Date(this.clock.now());
      const due = await manager.query<DueHold[]>(
        `SELECT hold.id AS hold_id, placed.id AS order_id, hold.date_id, hold.quantity
           FROM seat_hold AS hold
           JOIN seat_order AS placed ON placed.hold_id = hold.id
          WHERE hold.state = $1 AND hold.expires_at <= $2
          ORDER BY hold.expires_at
          LIMIT $3
            FOR UPDATE OF hold, placed SKIP LOCKED`,
        [SeatHoldState.ACTIVE, now, batch],
      );
      await this.failPendingOrdersWithoutHold(manager, now);
      if (due.length === 0) return 0;

      await manager.query(
        `UPDATE seat_hold SET state = $2, version = version + 1, updated_at = now()
          WHERE id = ANY($1)`,
        [due.map(({ hold_id }) => hold_id), SeatHoldState.EXPIRED],
      );
      await manager.query(
        `UPDATE seat_order
            SET state = $2, version = version + 1, updated_at = now(),
                intent_cancel_owed_at =
                  CASE WHEN payment_intent_ref IS NULL THEN NULL ELSE $3::timestamptz END
          WHERE id = ANY($1) AND state = ANY($4)`,
        [due.map(({ order_id }) => order_id), OrderState.FAILED, now, AWAITING_PAYMENT],
      );
      for (const [dateId, quantity] of seatsByDate(due)) {
        await dateSales.returnHeldSeats(dateId, quantity);
      }
      return due.length;
    });
  }

  /**
   * An order whose hold went back while the provider did not answer, and whose purchase was never
   *   retried under its key, fails at its expiry rather than stay pending: nothing holds for it.
   */
  private async failPendingOrdersWithoutHold(manager: EntityManager, now: Date): Promise<void> {
    await manager.query(
      `UPDATE seat_order SET state = $1, version = version + 1, updated_at = now()
        WHERE id IN (SELECT placed.id
                       FROM seat_order AS placed
                       JOIN seat_hold AS hold ON hold.id = placed.hold_id
                      WHERE placed.state = $2 AND placed.payment_intent_ref IS NULL
                        AND placed.expires_at <= $3 AND hold.state <> $4
                        FOR UPDATE OF placed SKIP LOCKED)`,
      [OrderState.FAILED, OrderState.PENDING, now, SeatHoldState.ACTIVE],
    );
  }
}

/** Sorted by date, so two passes on shared dates take their rows in one order. */
function seatsByDate(due: readonly DueHold[]): [string, number][] {
  const byDate = new Map<string, number>();
  for (const { date_id, quantity } of due)
    byDate.set(date_id, (byDate.get(date_id) ?? 0) + quantity);
  return [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right));
}
