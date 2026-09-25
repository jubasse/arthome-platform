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

/** The development stack's OpenSearch, published on 19200 by `compose.yaml`. */

/** What an attempt to write one document ended as. */
export type IndexWrite = 'indexed' | 'superseded';

/**
 * The slice of OpenSearch this service uses — an interface, not the client.
 *
 * ⚠ THE PORT EXISTS SO THE HANDLER CAN BE TESTED WITHOUT A CLUSTER. Every
 *   decision worth asserting — applied once, duplicate, wrong type, missing
 *   header, undecodable bytes, a stale event losing to a newer one — is a
 *   decision the handler makes BEFORE any network call. A test that needed a
 *   container to reach them would be run rarely and therefore would not be run.
 */
export interface ShowIndex {
  /**
   * Upsert one show document under its own id.
   *
   * @param version - the external version; a write whose version is older than
   *   what is stored is refused by OpenSearch rather than applied.
   */
  put(document: ShowDocument, version: number): Promise<IndexWrite>;
}

/**
 * ⚠ RETRY AT ONE LAYER, AND THE CLIENT'S OWN BUDGET IS THE ONE TO GIVE UP. It
 *   defaults to `maxRetries: 3` with `requestTimeout: 30000`, which sits on top of
 *   `libs/messaging`'s three tiers — 9 attempts, and a dead node holding a partition
 *   for 90 s before the messaging layer is even told. `failure.ts` records the same
 *   trap for KafkaJS: a client retry, the broker's redelivery and the retry budget
 *   MULTIPLY. So retry belongs to the consumer, which can dead-letter; the client
 *   fails once and fast.
 */
export function createOpenSearchClient(url: string): Client {
  return new Client({ node: url, maxRetries: 0, requestTimeout: 5_000 });
}

/**
 * The HTTP status behind a client error, when there is one.
 *
 * ⚠ TWO STATUSES CARRY MEANING ON THIS PATH AND THE REST DO NOT. 409 is a
 *   version conflict, which is NOT a failure here: `version_type: external_gte`
 *   refuses a write whose version is older than the stored document's, which is
 *   exactly what an event replayed off the retry topic five minutes late looks
 *   like — letting it throw would retry it, fail again for the same reason, and
 *   dead-letter a message whose effect is already correctly in the index. 400
 *   is the mapping refusing the document, which no retry fixes. Everything else
 *   stays unrecognised on purpose, and therefore transient.
 */
function statusOf(error: unknown): number | null {
  if (!(error instanceof Error) || !('statusCode' in error)) return null;
  return typeof error.statusCode === 'number' ? error.statusCode : null;
}

/**
 * The real index, behind the port.
 *
 * ⚠ IT WRITES THROUGH THE ALIAS, never the concrete index — see
 *   `SHOW_INDEX_ALIAS`. The whole point of the alias is that a reindex can move
 *   it without this service knowing.
 *
 * ⚠ `version_type: external_gte` AND NOT `external`, AND THE DIFFERENCE IS ONE
 *   THE CONTRACT FORCES. `external` demands strictly greater, and the version
 *   here is the event's `occurred_at` in milliseconds: two events about one
 *   show within the same millisecond — a bulk publication, a fixture load —
 *   would see the second refused and its content lost. `external_gte` accepts
 *   an equal version, so a redelivery of the same message rewrites the same
 *   bytes and a same-millisecond pair applies in arrival order, while anything
 *   genuinely older is still refused.
 *
 * ⚠ THIS IS THE GUARD AGENTS.md SAYS IS OWED. "A retry topic reorders one key's
 *   events … the guard is an aggregate version on the consumer's side." Here it
 *   is, for this projection: the index itself refuses to go backwards, so no
 *   ordering assumption is made about what Kafka hands us.
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
        if (status === 409) return 'superseded';

        // ⚠ A 400 IS PERMANENT, AND SAYING SO IS WORTH THE SPECIAL CASE. The
        //   document is a pure function of the event, so bytes a strict mapping
        //   rejects today it rejects identically on every retry. Left
        //   unclassified it would be treated as transient — correct as a
        //   default, wrong here — and would reach the dead-letter queue three
        //   attempts later under the reason `exhausted`, which says "a
        //   dependency never came back". The two reasons mean opposite things
        //   and the whole value of recording one is telling them apart.
        if (status === 400) {
          throw new PermanentError(
            `OpenSearch refused document ${document.show_id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        // Everything else is left to the caller, which leaves it to
        // @arthome-platform/messaging — where an unrecognised failure is
        // transient, because discarding a transient failure loses the fact.
        throw error;
      }
    },
  };
}

/**
 * Create the index and its alias, or bring an existing one up to the mapping.
 *
 * ⚠ ADDITIVE ONLY, AND OPENSEARCH ENFORCES IT WHETHER OR NOT WE DO. A field can
 *   be added to a live mapping; a field's type, its normalizer and the shard
 *   count cannot be changed in place — `put_mapping` answers 400. So this
 *   function deliberately does not try to reconcile anything: it adds what is
 *   missing and lets OpenSearch refuse what is not addable, loudly, at startup,
 *   where it is read. The alternative — catching that 400 — would start a
 *   service whose index does not match the documents it is about to write, and
 *   the first symptom would be a query returning nothing.
 *
 * ⚠ A NON-ADDITIVE CHANGE IS A REINDEX, NOT A DEPLOY. Create `…-v2` with the
 *   new mapping, reindex into it, then move `SHOW_INDEX_ALIAS` in one
 *   `_aliases` call. Readers and this writer see the swap atomically because
 *   none of them names a concrete index.
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
      // ⚠ THE ALIAS IS CREATED WITH THE INDEX, IN THE SAME CALL. Created after,
      //   there is a window in which the index exists and the alias does not —
      //   and this service writes to the alias, so in that window every write
      //   fails with "no such index" against a cluster that is perfectly
      //   healthy.
      aliases: { [SHOW_INDEX_ALIAS]: {} },
    },
  });
}

/**
 * ⚠ A 404 HERE IS AN ANSWER, NOT AN ERROR. The client raises on a non-2xx, and
 *   "the index is not there" is precisely what this function is asking about —
 *   so the one status that means `false` has to be caught rather than
 *   propagated. Every other status still propagates: a cluster that is refusing
 *   connections must not be read as an empty cluster, because the repair for
 *   that misreading is creating an index beside the real one.
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
