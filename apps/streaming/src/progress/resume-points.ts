import type { EntityManager } from 'typeorm';

import { RunState, type Instant } from '@arthome/core';

export interface StoredPoint {
  readonly positionSec: number;
  readonly version: number;
}

export interface Progress {
  readonly positionSec: number;
  readonly writtenAt: Instant;
  readonly completed: boolean;
  readonly version: number;
}

export interface PointWrite {
  readonly ownerId: string;
  readonly accountId: string;
  readonly profileId: string;
  readonly deviceId: string;
  readonly dateId: string;
  readonly positionSec: number;
  readonly completed: boolean;
  readonly at: Instant;
}

interface PointRow {
  readonly position_sec: number;
  readonly version: string;
}

interface ProgressRow extends PointRow {
  readonly date_id: string;
  readonly written_at: Date;
  readonly completed: boolean;
}

export const PROGRESS_ON_SQL = `SELECT date_id, position_sec, completed, version, written_at
         FROM resume_point
        WHERE owner_id = $1 AND date_id = ANY($2::uuid[]) AND account_id = $3`;

/**
 * The resume points, each read and written on its primary key, with no screen lock: one statement
 *   on its own row. The rank is the row's `version`, taken from the server (`data-model.md` §5.5).
 */
export class ResumePoints {
  public constructor(private readonly manager: EntityManager) {}

  /**
   * One statement: the upsert, taken only once the date's run has ended (D-111). Null when the run
   *   has not, and nothing was written.
   */
  public async recordAfterRun(write: PointWrite): Promise<StoredPoint | null> {
    const rows = await this.manager.query<PointRow[]>(
      `INSERT INTO resume_point (owner_id, date_id, account_id, profile_id, device_id,
                                 position_sec, completed, version, written_at)
            SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::integer, $7::boolean,
                   1, $8::timestamptz
             WHERE EXISTS (SELECT 1 FROM run WHERE date_id = $2::uuid AND state = '${RunState.ENDED}')
       ON CONFLICT (owner_id, date_id) DO UPDATE
               SET position_sec = excluded.position_sec, completed = excluded.completed,
                   device_id = excluded.device_id, written_at = excluded.written_at,
                   version = resume_point.version + 1
        RETURNING position_sec, version`,
      [
        write.ownerId,
        write.dateId,
        write.accountId,
        write.profileId,
        write.deviceId,
        write.positionSec,
        write.completed,
        write.at,
      ],
    );
    const [row] = rows;
    return row === undefined ? null : pointOf(row);
  }

  public async stored(ownerId: string, dateId: string): Promise<StoredPoint | null> {
    const [row] = await this.manager.query<PointRow[]>(
      `SELECT position_sec, version FROM resume_point WHERE owner_id = $1 AND date_id = $2`,
      [ownerId, dateId],
    );
    return row === undefined ? null : pointOf(row);
  }

  /** The caller's points on the dates, keyed by date id: a date without one is absent. */
  public async progressOn(
    ownerId: string,
    accountId: string,
    dateIds: readonly string[],
  ): Promise<Record<string, Progress>> {
    const rows = await this.manager.query<ProgressRow[]>(PROGRESS_ON_SQL, [
      ownerId,
      dateIds,
      accountId,
    ]);
    return Object.fromEntries(
      rows.map((row) => [
        row.date_id,
        {
          ...pointOf(row),
          writtenAt: row.written_at.toISOString(),
          completed: row.completed,
        },
      ]),
    );
  }
}

function pointOf(row: PointRow): StoredPoint {
  return { positionSec: row.position_sec, version: Number(row.version) };
}
