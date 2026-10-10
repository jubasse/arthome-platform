import { AggregateTracker, saveVersioned, type Track } from '@arthome-platform/transactions';
import type { EntityManager } from 'typeorm';

import { waitlistEntryMayMove, WaitlistEntryState, type Instant } from '@arthome/core';

import { WaitlistEntry, type WaitlistEntrySnapshot } from './waitlist-entry.aggregate.js';
import { WaitlistEntryRow } from './waitlist-entry.entity.js';
import { WaitlistEntryRepository } from './waitlist-entry.repository.js';

/**
 * The states a set-based statement moves from, as SQL literals, once core allowed each move: a
 *   literal, not a parameter, so the planner proves `idx_waitlist_entry_on_list`'s predicate.
 */
function movedFrom(from: readonly WaitlistEntryState[], to: WaitlistEntryState): string {
  for (const state of from) {
    if (!waitlistEntryMayMove(state, to))
      throw new Error(`no waitlist move from ${state} to ${to}`);
  }
  return from.map((state) => `'${state}'`).join(', ');
}

/**
 * Each notified entry whose account paid an order on the date since it was told, the order looked
 *   up per entry through `seat_order_idempotency`'s leading `account_id`: a lateral `LIMIT 1` the
 *   planner cannot turn into a hash join over every order ever placed.
 */
export const CONVERT_NOTIFIED_ENTRIES = `
  UPDATE waitlist_entry
     SET state = '${WaitlistEntryState.CONVERTED}', ended_at = $2, version = version + 1,
         updated_at = now()
   WHERE id IN (SELECT entry.id
                  FROM waitlist_entry AS entry
                 CROSS JOIN LATERAL (SELECT 1
                                       FROM seat_order AS placed
                                      WHERE placed.account_id = entry.account_id
                                        AND placed.date_id = entry.date_id
                                        AND placed.paid_at >= entry.notified_at
                                      LIMIT 1) AS paid
                 WHERE entry.date_id = $1
                   AND entry.state IN (${movedFrom([WaitlistEntryState.NOTIFIED], WaitlistEntryState.CONVERTED)}))
`;

export class TypeOrmWaitlistEntryRepository extends WaitlistEntryRepository {
  private readonly tracker: AggregateTracker<WaitlistEntry>;

  public constructor(
    private readonly manager: EntityManager,
    track: Track,
  ) {
    super();
    this.tracker = new AggregateTracker(track);
  }

  public async findByAccount(dateId: string, accountId: string): Promise<WaitlistEntry | null> {
    const row = await this.manager.findOne(WaitlistEntryRow, {
      where: { date_id: dateId, account_id: accountId },
      lock: { mode: 'pessimistic_write' },
    });
    if (row === null) return null;
    return this.tracker.loaded(WaitlistEntry.restore(waitlistEntrySnapshotOf(row)), row.version);
  }

  public async stateOf(dateId: string, accountId: string): Promise<WaitlistEntryState | null> {
    const row = await this.manager.findOne(WaitlistEntryRow, {
      select: { state: true },
      where: { date_id: dateId, account_id: accountId },
    });
    return row?.state ?? null;
  }

  public async save(entry: WaitlistEntry): Promise<void> {
    const current = entry.snapshot;
    const loadedVersion = this.tracker.versionOf(entry);
    if (loadedVersion === undefined) {
      await this.manager.insert(WaitlistEntryRow, {
        id: current.id,
        date_id: current.dateId,
        account_id: current.accountId,
        ...stateColumnsOf(current),
      });
    } else {
      await saveVersioned(
        this.manager,
        WaitlistEntryRow,
        { id: current.id },
        loadedVersion,
        stateColumnsOf(current),
        ({ version }) => ({ currentVersion: version }),
      );
    }
    this.tracker.written(entry, current.version);
  }

  public async notifyAll(dateId: string, now: Instant): Promise<string[]> {
    const { WAITING, NOTIFIED } = WaitlistEntryState;
    const rows = await this.manager.query<{ account_id: string }[]>(
      `WITH notified AS (
         UPDATE waitlist_entry
            SET state = '${NOTIFIED}',
                notified_at = CASE WHEN state = '${NOTIFIED}' THEN notified_at ELSE $2 END,
                version = version + 1, updated_at = now()
          WHERE date_id = $1 AND state IN (${movedFrom([WAITING, NOTIFIED], NOTIFIED)})
         RETURNING account_id
       )
       SELECT account_id FROM notified ORDER BY account_id`,
      [dateId, new Date(now)],
    );
    return rows.map(({ account_id }) => account_id);
  }

  public async endNotified(
    dateId: string,
    otherwise: typeof WaitlistEntryState.LAPSED | typeof WaitlistEntryState.CLOSED,
    now: Instant,
  ): Promise<number> {
    const { NOTIFIED } = WaitlistEntryState;
    const converted = await this.updated(CONVERT_NOTIFIED_ENTRIES, [dateId, new Date(now)]);
    const ended = await this.updated(
      `UPDATE waitlist_entry
          SET state = '${otherwise}', ended_at = $2, version = version + 1, updated_at = now()
        WHERE date_id = $1 AND state IN (${movedFrom([NOTIFIED], otherwise)})`,
      [dateId, new Date(now)],
    );
    return converted + ended;
  }

  public closeWaiting(dateId: string, now: Instant): Promise<number> {
    const { WAITING, CLOSED } = WaitlistEntryState;
    return this.updated(
      `UPDATE waitlist_entry
          SET state = '${CLOSED}', ended_at = $2, version = version + 1, updated_at = now()
        WHERE date_id = $1 AND state IN (${movedFrom([WAITING], CLOSED)})`,
      [dateId, new Date(now)],
    );
  }

  private async updated(sql: string, parameters: unknown[]): Promise<number> {
    const [, count] = await this.manager.query<[unknown, number]>(sql, parameters);
    return count;
  }
}

const dateOf = (instant: string | null): Date | null =>
  instant === null ? null : new Date(instant);

export function waitlistEntrySnapshotOf(row: WaitlistEntryRow): WaitlistEntrySnapshot {
  return {
    id: row.id,
    dateId: row.date_id,
    accountId: row.account_id,
    state: row.state,
    joinedAt: row.joined_at.toISOString(),
    notifiedAt: row.notified_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    version: row.version,
  };
}

function stateColumnsOf(
  entry: WaitlistEntrySnapshot,
): Omit<WaitlistEntryRow, 'id' | 'date_id' | 'account_id' | 'created_at' | 'updated_at'> {
  return {
    state: entry.state,
    joined_at: new Date(entry.joinedAt),
    notified_at: dateOf(entry.notifiedAt),
    ended_at: dateOf(entry.endedAt),
    version: entry.version,
  };
}
