import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { outboxTopic } from '@arthome-platform/messaging';
import { describe, expect, it } from 'vitest';

import { CATALOG_EVENT_TOPICS } from './catalog-events.js';

const declared = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../infra/kafka/topics.json', import.meta.url)), 'utf8'),
) as { readonly topics: readonly { readonly name: string }[] };
const provisioned = new Set(declared.topics.map(({ name }) => name));

describe('the topic each catalog event is routed to', () => {
  /** A publication event on `arthome.catalog.publication` fails here: no such topic is declared. */
  it.each(Object.entries(CATALOG_EVENT_TOPICS))('%s is declared in topics.json', (_, topic) => {
    expect(provisioned).toContain(outboxTopic(topic));
  });

  it('is its own context’s', () => {
    for (const [type, topic] of Object.entries(CATALOG_EVENT_TOPICS)) {
      expect(topic.split('.')[0]).toBe(type.split('.')[0]);
    }
  });
});
