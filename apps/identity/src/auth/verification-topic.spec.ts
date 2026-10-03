import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface DeclaredTopics {
  readonly topics: readonly { readonly name: string; readonly partitions: number }[];
}

const declared = JSON.parse(
  readFileSync(new URL('../../../../infra/kafka/topics.json', import.meta.url), 'utf8'),
) as DeclaredTopics;

describe('the topic the verification link travels on', () => {
  it('is provisioned apart from the account topic, which other contexts may read (events.md §3)', () => {
    expect(declared.topics).toContainEqual({
      name: 'arthome.identity.email_verification',
      partitions: 3,
    });
  });
});
