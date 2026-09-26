import { describe, expect, it } from 'vitest';

import { DateOutcome, Locale } from '@arthome/core';

import { DeclareOutcomeSchema } from './declare-outcome.schema.js';

const message = {
  contentLanguage: Locale.FR,
  text: 'Report au 12 novembre. Vos places restent valables.',
};

describe('DeclareOutcomeSchema', () => {
  it('requires rescheduledTo for a postponement, and only there', () => {
    const postponed = { outcome: DateOutcome.POSTPONED, message, expectedVersion: 3 };
    const cancelled = { outcome: DateOutcome.CANCELLED, message, expectedVersion: 3 };
    const at = '2026-11-12T19:30:00.000Z';

    expect(DeclareOutcomeSchema.safeParse({ ...postponed, rescheduledTo: at }).success).toBe(true);
    expect(DeclareOutcomeSchema.safeParse(cancelled).success).toBe(true);
    for (const body of [postponed, { ...cancelled, rescheduledTo: at }]) {
      const result = DeclareOutcomeSchema.safeParse(body);
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([['rescheduledTo']]);
    }
  });

  it('bounds the run desk’s message, as the contract does', () => {
    const body = { outcome: DateOutcome.CANCELLED, expectedVersion: 3 };

    expect(
      DeclareOutcomeSchema.safeParse({ ...body, message: { ...message, text: 'x'.repeat(601) } })
        .success,
    ).toBe(false);
    expect(
      DeclareOutcomeSchema.safeParse({ ...body, message: { ...message, text: '' } }).success,
    ).toBe(false);
  });
});
