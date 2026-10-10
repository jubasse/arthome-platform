import { Outcome, claimMessage } from '@arthome-platform/messaging';
import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import { SeatState, type Clock } from '@arthome/core';

import { reportStaleness } from './freshness.js';
import { RecordSeatFact } from './record-seat-fact.command.js';
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
    if (outcome === Outcome.APPLIED) {
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
