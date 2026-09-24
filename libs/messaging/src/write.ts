import type { EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { OutboxEvent } from './outbox-event.entity.js';

export interface OutboxFact {
  /** `identity.account` — becomes the topic, and must be topic-safe. */
  readonly aggregateType: string;
  /** The partition key: one aggregate's events stay in order because of it. */
  readonly aggregateId: string;
  /** `identity.account.registered.v1` — routes to a handler inside the topic. */
  readonly type: string;
  /** Already serialised. The relay transports bytes and reads none of them. */
  readonly payload: Uint8Array;
  /** W3C traceparent of the request that caused this, or null. */
  readonly traceparent: string | null;
  /** The person who caused the fact, when there is one. */
  readonly actorId?: string | null;
}

/**
 * Record a fact for publication, through the caller's transaction manager.
 *
 * ⚠ THE `manager` ARGUMENT IS THE WHOLE GUARANTEE, and it is why this takes one
 *   rather than a repository of its own. It must be the manager of the
 *   transaction that is writing the business row: never `save()` then `emit()`,
 *   because a crash between the two loses the event and a rollback after the
 *   emission invents one.
 *
 * ⚠ IT RETURNS THE MESSAGE ID, and that id is not the aggregate's. It becomes
 *   the `message-id` header, hence every consumer's deduplication key: reusing
 *   the aggregate id would make a second event about the same object look like a
 *   duplicate of the first, and consumers would silently drop it.
 */
export async function writeOutboxEvent(
  manager: EntityManager,
  fact: OutboxFact,
  occurredAt: Date = new Date(),
): Promise<string> {
  const messageId = uuidv7();
  await manager.insert(OutboxEvent, {
    id: messageId,
    aggregatetype: fact.aggregateType,
    aggregateid: fact.aggregateId,
    type: fact.type,
    payload: Buffer.from(fact.payload),
    tracecontext: fact.traceparent,
    actor_id: fact.actorId ?? null,
    created_at: occurredAt,
  });
  return messageId;
}
