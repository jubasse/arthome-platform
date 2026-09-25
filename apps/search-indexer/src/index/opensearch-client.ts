import { PermanentError } from '@arthome-platform/messaging';
import { Client } from '@opensearch-project/opensearch';

import {
  SHOW_INDEX_ALIAS,
  SHOW_INDEX_CONCRETE,
  SHOW_INDEX_MAPPING,
  SHOW_INDEX_PROPERTIES,
  SHOW_INDEX_SETTINGS,
  type ShowDocument,
} from './show-document.js';

export type IndexWrite = 'indexed' | 'superseded';

/**
 * ⚠ An interface rather than the client so the handler can be tested without a
 *   cluster. Every decision worth asserting — applied, duplicate, wrong type, stale
 *   event — is made before any network call, and a test needing a container would
 *   not be run.
 */
export interface ShowIndex {
  /** `version` is external: OpenSearch refuses a write older than what is stored. */
  put(document: ShowDocument, version: number): Promise<IndexWrite>;
}

/**
 * ⚠ RETRY AT ONE LAYER. The client defaults to `maxRetries: 3` at
 *   `requestTimeout: 30000`, on top of `libs/messaging`'s three tiers — 9 attempts,
 *   and a dead node holding a partition 90 s before the messaging layer is told.
 *   `failure.ts` records the same multiplication for KafkaJS.
 */
export function createOpenSearchClient(url: string): Client {
  return new Client({ node: url, maxRetries: 0, requestTimeout: 5_000 });
}

function statusOf(error: unknown): number | null {
  if (!(error instanceof Error) || !('statusCode' in error)) return null;
  return typeof error.statusCode === 'number' ? error.statusCode : null;
}

/**
 * ⚠ `external_gte`, NOT `external`. `external` demands strictly greater, and the
 *   version is the event's `occurred_at` in milliseconds — two events about one show
 *   in the same millisecond would see the second refused and its content lost.
 *
 * ⚠ This is the consumer-side version guard AGENTS.md says a retry topic owes: the
 *   index refuses to go backwards, so nothing here assumes Kafka's ordering.
 */
export function showIndex(client: Client): ShowIndex {
  return {
    async put(document: ShowDocument, version: number): Promise<IndexWrite> {
      try {
        await client.index({
          index: SHOW_INDEX_ALIAS,
          id: document.show_id,
          body: document,
          version,
          version_type: 'external_gte',
        });
        return 'indexed';
      } catch (error) {
        const status = statusOf(error);

        // A replay arriving after a newer event: its effect is already in the index.
        if (status === 409) return 'superseded';

        // ⚠ The document is a pure function of the event, so a mapping that rejects
        //   these bytes rejects them identically for ever. Unclassified it would
        //   dead-letter as `exhausted` — "a dependency never came back" — and the two
        //   reasons mean opposite things.
        if (status === 400) {
          throw new PermanentError(
            `OpenSearch refused document ${document.show_id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        throw error;
      }
    },
  };
}

/**
 * ⚠ ADDITIVE ONLY, AND OPENSEARCH ENFORCES IT. A field can be added to a live
 *   mapping; a type, a normalizer and the shard count cannot, and `put_mapping`
 *   answers 400. Nothing is reconciled here on purpose: catching that 400 would
 *   start a service whose index does not match what it is about to write, and the
 *   first symptom would be a query returning nothing.
 *
 *   A non-additive change is a reindex — create `…-v2`, reindex, move
 *   `SHOW_INDEX_ALIAS` in one `_aliases` call — not a deploy.
 */
export async function ensureShowIndex(client: Client): Promise<void> {
  if (await indexExists(client, SHOW_INDEX_CONCRETE)) {
    await client.indices.putMapping({
      index: SHOW_INDEX_CONCRETE,
      body: { properties: SHOW_INDEX_PROPERTIES },
    });
    return;
  }

  await client.indices.create({
    index: SHOW_INDEX_CONCRETE,
    body: {
      settings: SHOW_INDEX_SETTINGS,
      mappings: SHOW_INDEX_MAPPING,
      // ⚠ In the same call: created after, there is a window where the index exists
      //   and the alias does not, and every write to the alias fails against a
      //   healthy cluster.
      aliases: { [SHOW_INDEX_ALIAS]: {} },
    },
  });
}

/**
 * ⚠ A 404 is this function's answer, not an error, so it alone is caught. Every other
 *   status propagates: a cluster refusing connections must not read as an empty one,
 *   because the repair for that misreading is creating an index beside the real one.
 */
async function indexExists(client: Client, index: string): Promise<boolean> {
  try {
    const response = await client.indices.exists({ index });
    return response.body;
  } catch (error) {
    if (error instanceof Error && 'statusCode' in error && error.statusCode === 404) return false;
    throw error;
  }
}
