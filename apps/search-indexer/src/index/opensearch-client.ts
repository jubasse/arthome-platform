import { PermanentError } from '@arthome-platform/messaging';
import { Client, type Types } from '@opensearch-project/opensearch';

import {
  DATE_INDEX_ALIAS,
  DATE_INDEX_CONCRETE,
  DATE_INDEX_MAPPING,
  DATE_INDEX_PROPERTIES,
  type DateDocument,
} from './date-document.js';
import { INDEX_SETTINGS } from './settings.js';
import {
  SHOW_INDEX_ALIAS,
  SHOW_INDEX_CONCRETE,
  SHOW_INDEX_MAPPING,
  SHOW_INDEX_PROPERTIES,
  type ShowDocument,
} from './show-document.js';

export type IndexWrite = 'indexed' | 'superseded';

/** Interfaces, not the client, so a handler is testable without a cluster. */
export interface ShowIndex {
  put(document: ShowDocument, version: number): Promise<IndexWrite>;
}

export interface DateIndex {
  put(document: DateDocument, version: number): Promise<IndexWrite>;
}

export interface Indices {
  readonly shows: ShowIndex;
  readonly dates: DateIndex;
}

/**
 * RETRY AT ONE LAYER. The defaults (`maxRetries: 3`, `requestTimeout: 30000`) multiply
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
 * THE VERSION GUARD A RETRY TOPIC OWES: the index refuses to go backwards, so nothing
 *   here assumes Kafka's ordering. `external_gte` and not `external`, which demands
 *   strictly greater: an equal version is a rebuild of the same state, and must land.
 */
async function versionedPut(
  client: Client,
  alias: string,
  id: string,
  document: object,
  version: number,
): Promise<IndexWrite> {
  try {
    await client.index({ index: alias, id, body: document, version, version_type: 'external_gte' });
    return 'indexed';
  } catch (error) {
    const status = statusOf(error);
    if (status === 409) return 'superseded';
    if (status === 400) {
      throw new PermanentError(
        `OpenSearch refused ${alias}/${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
}

export function indicesOf(client: Client): Indices {
  return {
    shows: {
      put: (document, version) =>
        versionedPut(client, SHOW_INDEX_ALIAS, document.show_id, document, version),
    },
    dates: {
      put: (document, version) =>
        versionedPut(client, DATE_INDEX_ALIAS, document.date_id, document, version),
    },
  };
}

interface IndexDefinition {
  readonly concrete: string;
  readonly alias: string;
  readonly mapping: Types.Common_Mapping.TypeMapping;
  readonly properties: Record<string, Types.Common_Mapping.Property>;
}

/**
 * ADDITIVE ONLY, AND OPENSEARCH ENFORCES IT: a field can be added to a live mapping, a
 *   type, a normalizer and the shard count cannot, and `put_mapping` answers 400. That
 *   400 is left to fail the startup — a non-additive change is a reindex behind the
 *   alias, not a deploy.
 */
async function ensureIndex(client: Client, definition: IndexDefinition): Promise<void> {
  if (await indexExists(client, definition.concrete)) {
    await client.indices.putMapping({
      index: definition.concrete,
      body: { properties: definition.properties },
    });
    return;
  }
  await client.indices.create({
    index: definition.concrete,
    body: {
      settings: INDEX_SETTINGS,
      mappings: definition.mapping,
      aliases: { [definition.alias]: {} },
    },
  });
}

export async function ensureIndices(client: Client): Promise<void> {
  await ensureIndex(client, {
    concrete: SHOW_INDEX_CONCRETE,
    alias: SHOW_INDEX_ALIAS,
    mapping: SHOW_INDEX_MAPPING,
    properties: SHOW_INDEX_PROPERTIES,
  });
  await ensureIndex(client, {
    concrete: DATE_INDEX_CONCRETE,
    alias: DATE_INDEX_ALIAS,
    mapping: DATE_INDEX_MAPPING,
    properties: DATE_INDEX_PROPERTIES,
  });
}

/**
 * Only the 404 is caught, because it is the answer: a cluster refusing connections must
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
