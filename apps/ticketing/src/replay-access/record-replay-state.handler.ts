import { Outcome, claimMessage } from '@arthome-platform/messaging';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import type { EntityManager } from 'typeorm';

import {
  ApiErrorCode,
  DomainError,
  ReplayAccessOrigin,
  ReplayAccessRevocationReason,
  SeatState,
  type Clock,
  type DateOutcome,
  type Instant,
} from '@arthome/core';

import { RecordReplayState, type ReplayStateFact } from './record-replay-state.command.js';
import type { ReplayWindowRow } from './replay-window.entity.js';
import { nextReplayWindow, type ReplayWindow } from './replay-window.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

const OPEN_REPLAY_WINDOW = `
  INSERT INTO replay_window (date_id, state, version, policy, live_ended_at, closes_at, online_at,
                             recorded_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (date_id) DO NOTHING
  RETURNING date_id
`;

const LOCK_REPLAY_WINDOW = `SELECT * FROM replay_window WHERE date_id = $1 FOR UPDATE`;

const KEEP_REPLAY_WINDOW = `
  UPDATE replay_window
     SET state = $2, version = $3, policy = $4, live_ended_at = $5, closes_at = $6,
         online_at = $7, granted_at = $8, revoked_at = $9, recorded_at = $10
   WHERE date_id = $1
`;

/** Reads the seats unlocked through `idx_seat_date_active`; the unique `seat_id` adds none twice. */
export const GRANT_SEAT_ACCESSES = `
  INSERT INTO replay_access (id, date_id, seat_id, origin, granted_at)
  SELECT uuidv7(), date_id, id, $2, $3 FROM seat WHERE date_id = $1 AND state = $4
  ON CONFLICT (seat_id) DO NOTHING
`;

const REVOKE_ACCESSES = `
  UPDATE replay_access SET revoked_at = $2, revocation_reason = $3
   WHERE date_id = $1 AND revoked_at IS NULL
`;

const instantOf = (date: Date | null) => (date === null ? null : date.toISOString());
const dateOf = (instant: string | null) => (instant === null ? null : new Date(instant));

function replayWindowOf(row: ReplayWindowRow): ReplayWindow {
  return {
    state: row.state,
    version: BigInt(row.version),
    policy: row.policy,
    liveEndedAt: row.live_ended_at.toISOString(),
    closesAt: row.closes_at.toISOString(),
    onlineAt: instantOf(row.online_at),
    grantedAt: instantOf(row.granted_at),
    revokedAt: instantOf(row.revoked_at),
  };
}

/**
 * The `included` accesses of a date's seats (adr-replay §5, HANDOVER §0r): granted when the replay
 *   is first kept `pending` or `online`, revoked when it is withdrawn, ordered by the `Replay`'s
 *   version. Locks the window's row, then the accesses; never `seat_order` or `date_sales`, so no
 *   money path waits on it. Reached from Kafka alone: it refuses with core's `DomainError`.
 */
@CommandHandler(RecordReplayState)
export class RecordReplayStateHandler implements ICommandHandler<RecordReplayState> {
  public constructor(
    private readonly transactions: TicketingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute({ messageId, topic, fact }: RecordReplayState): Promise<Outcome> {
    return this.transactions.run(async ({ manager }) => {
      if (!(await claimMessage(manager, messageId, topic))) return Outcome.DUPLICATE;
      const outcome = await outcomeOf(manager, fact.dateId);
      const now = this.clock.now();
      const kept = await lockedWindow(manager, fact, now);
      const change = nextReplayWindow(kept, fact, outcome, now);
      if (change.kind === 'superseded') return Outcome.SUPERSEDED;

      const { window } = change;
      if (change.accesses === 'grant') {
        await manager.query(GRANT_SEAT_ACCESSES, [
          fact.dateId,
          ReplayAccessOrigin.SEAT,
          dateOf(window.grantedAt),
          SeatState.ACTIVE,
        ]);
      } else if (change.accesses === 'revoke') {
        await manager.query(REVOKE_ACCESSES, [
          fact.dateId,
          dateOf(window.revokedAt),
          ReplayAccessRevocationReason.REPLAY_WITHDRAWN,
        ]);
      }
      await manager.query(KEEP_REPLAY_WINDOW, [
        fact.dateId,
        window.state,
        window.version.toString(),
        window.policy,
        new Date(window.liveEndedAt),
        new Date(window.closesAt),
        dateOf(window.onlineAt),
        dateOf(window.grantedAt),
        dateOf(window.revokedAt),
        new Date(now),
      ]);
      return Outcome.APPLIED;
    });
  }
}

/** Unlocked: the grant reads the outcome, and a money path may hold the date's row. */
async function outcomeOf(manager: EntityManager, dateId: string): Promise<DateOutcome | null> {
  const rows = await manager.query<{ outcome: DateOutcome | null }[]>(
    `SELECT outcome FROM date_sales WHERE date_id = $1`,
    [dateId],
  );
  const [row] = rows;
  if (row === undefined) throw new DomainError({ code: ApiErrorCode.NOT_FOUND });
  return row.outcome;
}

/** Null when this fact opened the window: nobody kept anything of the date's `Replay` before. */
async function lockedWindow(
  manager: EntityManager,
  fact: ReplayStateFact,
  now: Instant,
): Promise<ReplayWindow | null> {
  const opened = await manager.query<unknown[]>(OPEN_REPLAY_WINDOW, [
    fact.dateId,
    fact.toState,
    fact.version.toString(),
    fact.policy,
    new Date(fact.liveEndedAt),
    new Date(fact.closesAt),
    dateOf(fact.onlineAt),
    new Date(now),
  ]);
  if (opened.length > 0) return null;
  const [row] = await manager.query<ReplayWindowRow[]>(LOCK_REPLAY_WINDOW, [fact.dateId]);
  if (row === undefined) throw new Error(`the replay window of date ${fact.dateId} vanished`);
  return replayWindowOf(row);
}
