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

/** An interface, not the client, so the handler is testable without a cluster. */
export interface ShowIndex {
  put(document: ShowDocument, version: number): Promise<IndexWrite>;
}

/**
 * ⚠ RETRY AT ONE LAYER. The defaults (`maxRetries: 3`, `requestTimeout: 30000`) multiply
 *   with `libs/messaging`'s three tiers: 9 attempts, and a dead node holds a partition
 *   90 s before the messaging layer hears about it.
 */
export function createOpenSearchClient(url: string): Client {
  return new Client({ node: url, maxRetries: 0, requestTimeout: 5_000 });
}

function statusOf(error: unknown): number | null {
  if (!(error instanceof Error) || !('statusCode' in error)) return null;
  return typeof error.statusCode === 'number' ? error.statusCode : null;
}

/**
 * ⚠ THE VERSION GUARD A RETRY TOPIC OWES: the index refuses to go backwards, so nothing
 *   here assumes Kafka's ordering. `external_gte` and not `external`, which demands
 *   strictly greater — two events about one show in the same millisecond would lose one.
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

        // A replay behind a newer event: its effect is already in the index.
        if (status === 409) return 'superseded';

        // ⚠ Permanent because the document is a pure function of the event. Unclassified
        //   it would dead-letter as `exhausted`, which means the opposite thing.
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
 * ⚠ ADDITIVE ONLY, AND OPENSEARCH ENFORCES IT: a field can be added to a live mapping, a
 *   type, a normalizer and the shard count cannot, and `put_mapping` answers 400. That
 *   400 is left to fail the startup — a non-additive change is a reindex behind the
 *   alias, not a deploy.
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
      // ⚠ In the same call: created after, there is a window in which every write to
      //   the alias fails against a healthy cluster.
      aliases: { [SHOW_INDEX_ALIAS]: {} },
    },
  });
}

/**
 * ⚠ Only the 404 is caught, because it is the answer: a cluster refusing connections must
 *   not read as an empty one, or the repair is a second index beside the real one.
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
