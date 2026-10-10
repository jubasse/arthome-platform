import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { Instant } from '@arthome/core';

import { PreviewBudgets } from './preview-budgets.js';
import { FRESH_BUDGET, coverAt, secondsLeftAt } from './preview-cover.js';
import { readRunSpans } from './run-spans.js';
import type { PreviewMeter } from '../playback/preview-meter.js';

/**
 * The preview budget counted on the server, per account and date (`adr-stream-entitlement.md` §4):
 *   the arithmetic is `preview-cover.ts`'s, this reads the run and keeps the row.
 */
@Injectable()
export class PostgresPreviewMeter implements PreviewMeter {
  public async secondsLeft(
    manager: EntityManager,
    accountId: string,
    dateId: string,
    now: Instant,
  ): Promise<number> {
    const budget = (await new PreviewBudgets(manager).read(accountId, dateId)) ?? FRESH_BUDGET;
    const { onAir } = await readRunSpans(manager, dateId, now);
    return secondsLeftAt(budget, now, onAir);
  }

  public async cover(
    manager: EntityManager,
    accountId: string,
    dateId: string,
    now: Instant,
  ): Promise<Instant | null> {
    const budgets = new PreviewBudgets(manager);
    const { onAir } = await readRunSpans(manager, dateId, now);
    const locked = await budgets.lock(accountId, dateId);
    const { budget, expiresAt } = coverAt(locked, now, onAir);
    await budgets.write(accountId, dateId, budget, now);
    return expiresAt;
  }
}
