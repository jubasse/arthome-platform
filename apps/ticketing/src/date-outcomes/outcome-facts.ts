import type { EntityManager } from 'typeorm';

import { SeatState, seatCancelDeadline, type DateOutcome, type Instant } from '@arthome/core';

/**
 * A cancellation or an interruption to settle, once: an outcome is final (D-076), and the message
 *   that states it is claimed in the same transaction. Nobody holds the row yet, so the insert
 *   waits on nothing.
 */
export async function recordOutcomeToSettle(
  manager: EntityManager,
  dateId: string,
  outcome: DateOutcome,
  recordedAt: Instant,
  traceparent: string | null,
): Promise<void> {
  await manager.query(
    `INSERT INTO date_outcome_settlement (date_id, outcome, recorded_at, traceparent)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (date_id) DO NOTHING`,
    [dateId, outcome, new Date(recordedAt), traceparent],
  );
}

/**
 * The date's active seats follow a start that moved (adr-ticketing.md §8): one statement through
 *   `idx_seat_date_active`, run before the date's row is locked, so no hold waits behind it. It
 *   moves none against a newer start already committed; how many it moved otherwise.
 */
export async function moveSeatCancelDeadlines(
  manager: EntityManager,
  dateId: string,
  startsAt: Instant,
  statedAt: Instant,
): Promise<number> {
  const [, moved] = await manager.query<[unknown[], number]>(
    `UPDATE seat SET cancel_deadline = $2
      WHERE date_id = $1 AND state = $4 AND cancel_deadline IS DISTINCT FROM $2
        AND NOT EXISTS (SELECT 1 FROM date_sales
                         WHERE date_id = $1 AND schedule_stated_at > $3)`,
    [dateId, new Date(seatCancelDeadline(startsAt)), new Date(statedAt), SeatState.ACTIVE],
  );
  return moved;
}
