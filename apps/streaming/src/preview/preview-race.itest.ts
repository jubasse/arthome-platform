import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PREVIEW_BUDGET_SECONDS, plusSeconds } from '@arthome/core';

import {
  CASE_MS,
  STARTUP_MS,
  liveDate,
  newViewer,
  openCall,
  renewCall,
  startPlayback,
  stopPlayback,
  ticketOf,
  type Playback,
} from '../itest/playback.js';
import { budgetOf } from '../itest/preview.js';

/** Renewals of one account at once queue on its screens' lock and never spend past the budget. */

let playback: Playback;

beforeAll(async () => {
  playback = await startPlayback('streaming_preview_race_itest');
}, STARTUP_MS);

afterAll(async () => {
  await stopPlayback(playback);
});

describe('the preview budget under concurrent renewals', () => {
  it(
    'never spends past the budget when several renewals of one account land at once',
    async () => {
      const viewer = newViewer();
      const dateId = await liveDate(playback);
      const opened = ticketOf(await openCall(playback, viewer, dateId));
      await playback.dataSource.query(
        `UPDATE preview_budget SET settled_seconds = $3, covered_until = $4, settled_until = $4
          WHERE account_id = $1 AND date_id = $2`,
        [viewer.accountId, dateId, PREVIEW_BUDGET_SECONDS - 50, playback.clock.now()],
      );
      const now = playback.clock.now();

      const renewals = await Promise.all(
        Array.from({ length: 6 }, () => renewCall(playback, viewer, opened.sessionId)),
      );

      expect(renewals.map(({ statusCode }) => statusCode)).toEqual(Array(6).fill(200));
      for (const renewal of renewals) {
        const { expiresAt } = (JSON.parse(renewal.body) as { data: { expiresAt: string } }).data;
        expect(expiresAt <= plusSeconds(now, 50)).toBe(true);
      }
      const row = await budgetOf(playback, viewer.accountId, dateId);
      expect((row?.settled_seconds ?? 0) + (row?.precharged_seconds ?? 0)).toBeLessThanOrEqual(
        PREVIEW_BUDGET_SECONDS,
      );
    },
    CASE_MS,
  );
});
