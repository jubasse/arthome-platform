import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { REPUBLISH_HORIZON_HOURS } from './republish.js';
import { PROCESSED_MESSAGE_RETENTION_DAYS } from './retention.js';

interface DeclaredTopics {
  readonly retentionHours: number;
  readonly topics: readonly { readonly name: string; readonly retentionHours?: number }[];
}

const declared = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../infra/kafka/topics.json', import.meta.url)), 'utf8'),
) as DeclaredTopics;

const retentions = declared.topics.map(({ name, retentionHours }) => ({
  name,
  hours: retentionHours ?? declared.retentionHours,
}));

describe('the retention declared in infra/kafka/topics.json', () => {
  it('is a positive number of hours for every topic', () => {
    for (const { name, hours } of retentions) expect(hours, name).toBeGreaterThan(0);
  });

  it('stays below the ledger’s, so a replayed message still finds its processed_message row', () => {
    const outliving = retentions.filter(
      ({ hours }) => hours >= PROCESSED_MESSAGE_RETENTION_DAYS * 24,
    );
    expect(outliving).toEqual([]);
  });

  it('outlives the republish horizon, so a message-id absent from its topic was never published', () => {
    const shorter = retentions.filter(({ hours }) => hours <= REPUBLISH_HORIZON_HOURS);
    expect(shorter).toEqual([]);
  });
});
