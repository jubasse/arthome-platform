import { updateReturning } from '@arthome-platform/transactions';
import type { EntityManager } from 'typeorm';

import type { Instant } from '@arthome/core';

import type { BudgetState } from './preview-cover.js';

interface BudgetRow {
  readonly settled_seconds: number;
  readonly precharged_seconds: number;
  readonly covered_until: Date | null;
  readonly settled_until: Date | null;
}

function stateOf(row: BudgetRow): BudgetState {
  return {
    settledSeconds: row.settled_seconds,
    prechargedSeconds: row.precharged_seconds,
    coveredUntil: row.covered_until?.toISOString() ?? null,
    settledUntil: row.settled_until?.toISOString() ?? null,
  };
}

/**
 * The preview budgets, one row per account and date: the lock order's last row. The row is created
 *   by `ON CONFLICT DO NOTHING`, read `FOR UPDATE` and written by one `UPDATE … RETURNING`.
 */
export class PreviewBudgets {
  public constructor(private readonly manager: EntityManager) {}

  /** The row as it stands, with no lock, or null before the first cover. */
  public async read(accountId: string, dateId: string): Promise<BudgetState | null> {
    const [row] = await this.manager.query<BudgetRow[]>(
      `SELECT settled_seconds, precharged_seconds, covered_until, settled_until
         FROM preview_budget WHERE account_id = $1 AND date_id = $2`,
      [accountId, dateId],
    );
    return row === undefined ? null : stateOf(row);
  }

  public async lock(accountId: string, dateId: string): Promise<BudgetState> {
    await this.manager.query(
      `INSERT INTO preview_budget (account_id, date_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [accountId, dateId],
    );
    const [row] = await this.manager.query<BudgetRow[]>(
      `SELECT settled_seconds, precharged_seconds, covered_until, settled_until
         FROM preview_budget WHERE account_id = $1 AND date_id = $2 FOR UPDATE`,
      [accountId, dateId],
    );
    if (row === undefined)
      throw new Error(`the preview budget of ${accountId} on ${dateId} vanished`);
    return stateOf(row);
  }

  public async write(
    accountId: string,
    dateId: string,
    budget: BudgetState,
    now: Instant,
  ): Promise<BudgetState> {
    const [row] = await updateReturning<BudgetRow>(
      this.manager,
      `UPDATE preview_budget
          SET settled_seconds = $3, precharged_seconds = $4, covered_until = $5,
              settled_until = $6, updated_at = $7
        WHERE account_id = $1 AND date_id = $2
    RETURNING settled_seconds, precharged_seconds, covered_until, settled_until`,
      [
        accountId,
        dateId,
        budget.settledSeconds,
        budget.prechargedSeconds,
        budget.coveredUntil,
        budget.settledUntil,
        now,
      ],
    );
    if (row === undefined)
      throw new Error(`the locked preview budget of ${accountId} was not found`);
    return stateOf(row);
  }
}
