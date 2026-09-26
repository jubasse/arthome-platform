import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { outboxTopic } from './outbox.js';
import { outboxSlotName } from './slot.js';

interface Connector {
  readonly name: string;
  readonly config: Readonly<Record<string, string>>;
}

const directory = fileURLToPath(new URL('../../../infra/debezium/', import.meta.url));
const connectors: readonly Connector[] = readdirSync(directory)
  .filter((file) => file.endsWith('-outbox.json'))
  .map((file) => JSON.parse(readFileSync(`${directory}${file}`, 'utf8')) as Connector);

/** The fields a connector names after its service; every other field must match across files. */
const SERVICE_FIELDS = ['database.dbname', 'topic.prefix', 'slot.name', 'publication.name'];

describe.each(connectors.map((connector) => [connector.name, connector] as const))(
  '%s',
  (_, { name, config }) => {
    const service = config['database.dbname'] ?? '';

    it('names its slot and publication as the readiness checks query them', () => {
      expect(name).toBe(`${service}-outbox`);
      expect(config['slot.name']).toBe(outboxSlotName(service));
      expect(config['publication.name']).toBe(outboxSlotName(service));
    });

    it('routes to the topic outboxTopic() derives, so reconciliation reads the right one', () => {
      const replacement = config['transforms.outbox.route.topic.replacement'] ?? '';
      expect(replacement.replace('${routedByValue}', 'catalog.show')).toBe(
        outboxTopic('catalog.show'),
      );
    });

    it('places the row id in the message-id header, which deduplication and reconciliation read', () => {
      expect(config['transforms.outbox.table.fields.additional.placement']).toContain(
        'id:header:message-id',
      );
    });

    /** Absent on 2026-09-25, and the publication came up FOR ALL TABLES, needing superuser. */
    it('creates its publication filtered to the outbox alone', () => {
      expect(config['publication.autocreate.mode']).toBe('filtered');
      expect(config['table.include.list']).toBe('public.outbox_event');
    });

    /** `all` would skip a record it cannot convert: a committed fact, lost. */
    it('fails loudly rather than skip a record', () => {
      expect(config['errors.tolerance']).toBe('none');
    });
  },
);

describe('the connector files', () => {
  it('exist for every publishing service', () => {
    expect(connectors.map(({ name }) => name).sort()).toEqual([
      'catalog-outbox',
      'identity-outbox',
    ]);
  });

  it('differ only in the fields named after their service', () => {
    const shared = connectors.map(({ config }) =>
      Object.fromEntries(Object.entries(config).filter(([key]) => !SERVICE_FIELDS.includes(key))),
    );
    for (const other of shared.slice(1)) expect(other).toEqual(shared[0]);
  });
});
