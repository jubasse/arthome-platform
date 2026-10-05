import type { EntityManager } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { OutboxEvent } from './outbox-event.entity.js';
import { outboxWriter } from './write.js';

const writeHarnessEvent = outboxWriter({
  'harness.probe.happened.v1': 'harness.probe',
  'harness.probe.retired.v1': 'harness.probe',
});

describe('outboxWriter', () => {
  it('writes the event on its type’s topic, keyed by its aggregate, with no actor', async () => {
    const inserted: unknown[][] = [];
    const manager = {
      insert: (...row: unknown[]) => {
        inserted.push(row);
        return Promise.resolve();
      },
    } as unknown as EntityManager;
    const occurredAt = new Date('2026-09-27T10:00:00.000Z');

    const messageId = await writeHarnessEvent(
      manager,
      {
        type: 'harness.probe.retired.v1',
        key: 'probe-1',
        payload: new Uint8Array([8, 1]),
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
      occurredAt,
    );

    expect(inserted).toEqual([
      [
        OutboxEvent,
        {
          id: messageId,
          aggregatetype: 'harness.probe',
          aggregateid: 'probe-1',
          type: 'harness.probe.retired.v1',
          payload: Buffer.from([8, 1]),
          tracecontext: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
          actor_id: null,
          created_at: occurredAt,
        },
      ],
    ]);
  });
});
