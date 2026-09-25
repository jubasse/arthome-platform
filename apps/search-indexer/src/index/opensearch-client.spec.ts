import { PermanentError } from '@arthome-platform/messaging';
import type { Client } from '@opensearch-project/opensearch';
import { describe, expect, it } from 'vitest';

import { showIndex } from './opensearch-client.js';
import type { ShowDocument } from './show-document.js';

const DOCUMENT = {
  show_id: '01a0d537-0abe-71f1-9ee1-d89eee348187',
  channel_id: '01a0d537-0abe-71f1-9ee1-000000000001',
  artist_id: '01a0d537-0abe-71f1-9ee1-000000000002',
  category_id: 'theatre',
  genre_ids: [],
  tag_ids: [],
  runtime_min: 95,
  language_dependency: null,
  spoken_languages: [],
  subtitle_languages: [],
  surtitle_languages: [],
  media: { wide: [], poster: [] },
  published_at: '2026-09-25T09:00:00.000Z',
  indexed_at: '2026-09-25T09:00:01.000Z',
} satisfies ShowDocument;

/** The client's errors carry `statusCode`; that is all this code reads of them. */
class FakeResponseError extends Error {
  constructor(readonly statusCode: number) {
    super(`fake ${String(statusCode)}`);
  }
}

function fakeClient(rejection?: Error): Client {
  return {
    index: () => (rejection === undefined ? Promise.resolve({}) : Promise.reject(rejection)),
  } as unknown as Client;
}

describe('showIndex', () => {
  it('reports a write that landed', async () => {
    await expect(showIndex(fakeClient()).put(DOCUMENT, 1)).resolves.toBe('indexed');
  });

  it('reads a version conflict as "a newer document already won", not as a failure', async () => {
    // This is what lets the consumer stop caring about Kafka's
    // ordering: an event that comes back off the retry topic five minutes late
    // is REFUSED by the index rather than applied over a newer one. Treating
    // the refusal as an error would retry it, fail identically three times, and
    // dead-letter a message whose effect is already correctly in place.
    await expect(showIndex(fakeClient(new FakeResponseError(409))).put(DOCUMENT, 1)).resolves.toBe(
      'superseded',
    );
  });

  it('calls a mapping refusal permanent, so it is not retried three times first', async () => {
    // `dynamic: strict` answers 400 for a document carrying a field the mapping
    // does not know. The document is a pure function of the event, so those
    // bytes are refused identically for ever — and reaching the dead-letter
    // queue as `exhausted` rather than `permanent` would say a dependency never
    // came back, about a message that was never going to work.
    await expect(
      showIndex(fakeClient(new FakeResponseError(400))).put(DOCUMENT, 1),
    ).rejects.toThrow(PermanentError);
  });

  it('lets every other failure through, so `messaging` can retry it', async () => {
    // The asymmetry is deliberate and it is events.md's: an unrecognised
    // failure is transient, because retrying a permanent one costs three
    // attempts while discarding a transient one loses the fact for good.
    await expect(
      showIndex(fakeClient(new FakeResponseError(503))).put(DOCUMENT, 1),
    ).rejects.toThrow(/fake 503/);
  });
});
