import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import type { EntityManager } from 'typeorm';

import { type Clock, OrderState, SeatHoldState } from '@arthome/core';

import { ExpireDueHolds } from './expire-due-holds.command.js';
import { CLOCK } from '../clock.js';
import type { HeldSeats } from '../date-sales/date-sales.repository.js';
import { TicketingTransactions } from '../ticketing-transactions.js';
import { ORDER_STATES_AWAITING_PAYMENT } from './awaiting-payment.js';

interface DueHold {
  readonly hold_id: string;
  readonly order_id: string;
  readonly date_id: string;
  readonly quantity: number;
  readonly pool_seats: number;
}

/**
 * adr-ticketing.md §6, set-based (HANDOVER §0i): the expired active holds with their orders,
 *   `FOR UPDATE SKIP LOCKED`, each hold `expired`, its order `failed`, its seats back last, one
 *   statement per date in `date_id` order. A hold whose order a payment holds is skipped, though
 *   the pass keeps the hold's lock it took first: that payment then waits for this pass's commit,
 *   and no deadlock follows, since the pass waits on nothing but dates' rows, which a payment takes
 *   after its hold.
 */
@CommandHandler(ExpireDueHolds)
export class ExpireDueHoldsHandler implements ICommandHandler<ExpireDueHolds> {
  public constructor(
    private readonly transactions: TicketingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute({ batch }: ExpireDueHolds): Promise<number> {
    return this.transactions.run(async ({ manager, dateSales }) => {
      const instant = this.clock.now();
      const now = new Date(instant);
      const due = await manager.query<DueHold[]>(
        `SELECT hold.id AS hold_id, placed.id AS order_id, hold.date_id, hold.quantity,
                hold.pool_seats
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
        [
          due.map(({ order_id }) => order_id),
          OrderState.FAILED,
          now,
          ORDER_STATES_AWAITING_PAYMENT,
        ],
      );
      for (const [dateId, seats] of seatsByDate(due)) {
        await dateSales.returnHeldSeats(dateId, seats, instant);
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
function seatsByDate(due: readonly DueHold[]): [string, HeldSeats][] {
  const byDate = new Map<string, HeldSeats>();
  for (const { date_id, quantity, pool_seats } of due) {
    const seats = byDate.get(date_id) ?? { quantity: 0, poolSeats: 0 };
    byDate.set(date_id, {
      quantity: seats.quantity + quantity,
      poolSeats: seats.poolSeats + pool_seats,
    });
  }
  return [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right));
}
