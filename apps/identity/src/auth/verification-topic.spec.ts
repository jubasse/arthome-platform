import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface DeclaredTopics {
  readonly topics: readonly { readonly name: string; readonly partitions: number }[];
}

const TOPIC = 'arthome.identity.email_verification';
const APPS = new URL('../../../', import.meta.url);

/** Every non-test source file of every app, so a subscription anywhere is seen. */
function sourcesNaming(topic: string): string[] {
  return readdirSync(APPS, { withFileTypes: true })
    .filter((app) => app.isDirectory())
    .flatMap((app) =>
      readdirSync(new URL(`${app.name}/src/`, APPS), { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.ts') && !/\.(spec|itest)\.ts$/.test(file))
        .filter((file) =>
          readFileSync(new URL(`${app.name}/src/${file}`, APPS), 'utf8').includes(topic),
        )
        .map((file) => `${app.name}/src/${file}`),
    );
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

  it('is named by no app but notifications, its only reader (infra/kafka/README.md)', () => {
    expect(sourcesNaming(TOPIC).filter((file) => !file.startsWith('notifications/'))).toEqual([]);
  });
});
