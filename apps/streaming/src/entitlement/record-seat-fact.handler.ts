import { Outcome, PermanentError, claimMessage } from '@arthome-platform/messaging';
import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import { SeatState, type Clock } from '@arthome/core';

import { reportStaleness } from './freshness.js';
import { RecordSeatFact, isCancellationOfKeptRow } from './record-seat-fact.command.js';
import { CLOCK } from '../clock.js';
import { StreamingTransactions } from '../streaming-transactions.js';

/**
 * Order-proof without an instant: an activation never overwrites a row, a cancellation always
 *   ends one, so any order of the two, their duplicates and a retried older copy ends in one row.
 */
export const ACTIVATE_SEAT = `
  INSERT INTO entitlement_seat (seat_id, account_id, date_id, state, occurred_at, applied_at)
       VALUES ($1, $2, $3, '${SeatState.ACTIVE}', $4, $5)
  ON CONFLICT (seat_id) DO NOTHING
    RETURNING seat_id`;

export const CANCEL_SEAT = `
  INSERT INTO entitlement_seat AS kept (seat_id, account_id, date_id, state, occurred_at, applied_at)
       VALUES ($1, $2, $3, '${SeatState.CANCELLED}', $4, $5)
  ON CONFLICT (seat_id) DO UPDATE
          SET state = '${SeatState.CANCELLED}', occurred_at = excluded.occurred_at,
              applied_at = excluded.applied_at
        WHERE kept.state = '${SeatState.ACTIVE}'
    RETURNING seat_id`;

/** A cancellation that states no account or date: it ends the kept row, which it must find. */
export const CANCEL_KEPT_SEAT = `
  WITH ended AS (
    UPDATE entitlement_seat
       SET state = '${SeatState.CANCELLED}', occurred_at = COALESCE($2, occurred_at), applied_at = $3
     WHERE seat_id = $1 AND state = '${SeatState.ACTIVE}'
    RETURNING seat_id)
  SELECT seat_id FROM ended`;

const SEAT_ROW_EXISTS = 'SELECT 1 FROM entitlement_seat WHERE seat_id = $1';

@CommandHandler(RecordSeatFact)
export class RecordSeatFactHandler implements ICommandHandler<RecordSeatFact> {
  private readonly logger = new Logger(RecordSeatFactHandler.name);

  public constructor(
    private readonly transactions: StreamingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute({ delivery, fact }: RecordSeatFact): Promise<Outcome> {
    const appliedAtMs = this.clock.nowMs();
    const outcome = await this.transactions.run(async ({ manager }) => {
      if (!(await claimMessage(manager, delivery.messageId, delivery.topic))) {
        return Outcome.DUPLICATE;
      }
      if (isCancellationOfKeptRow(fact)) {
        const ended = await manager.query<unknown[]>(CANCEL_KEPT_SEAT, [
          fact.seatId,
          fact.statedAt,
          new Date(appliedAtMs),
        ]);
        if (ended.length === 1) return Outcome.APPLIED;
        const kept = await manager.query<unknown[]>(SEAT_ROW_EXISTS, [fact.seatId]);
        if (kept.length === 0) {
          throw new PermanentError(`seat ${fact.seatId} cancelled without an account, none kept`);
        }
        return Outcome.SUPERSEDED;
      }
      const statement = fact.type === 'ticketing.seat.activated.v1' ? ACTIVATE_SEAT : CANCEL_SEAT;
      const written = await manager.query<unknown[]>(statement, [
        fact.seatId,
        fact.accountId,
        fact.dateId,
        fact.statedAt,
        new Date(appliedAtMs),
      ]);
      return written.length === 1 ? Outcome.APPLIED : Outcome.SUPERSEDED;
    });
    if (outcome === Outcome.APPLIED && !isCancellationOfKeptRow(fact)) {
      reportStaleness(
        this.logger,
        fact,
        `date=${fact.dateId} account=${fact.accountId}`,
        appliedAtMs,
      );
    }
    return outcome;
  }
}
