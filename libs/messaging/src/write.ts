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
  readonly traceparent: string | null;
  /** The person who caused the fact, when there is one. */
  readonly actorId?: string | null;
}

/**
 * The `manager` argument is the whole guarantee, and it is why this takes one rather than a
 *   repository of its own: it must be the manager of the transaction writing the business
 *   row. Never `save()` then `emit()` — a crash between the two loses the event, a rollback
 *   after the emission invents one.
 * The returned id is the MESSAGE's, not the aggregate's. It becomes the `message-id` header
 *   and hence every consumer's dedup key: reusing the aggregate id would make a second event
 *   about the same object look like a duplicate of the first, and consumers would drop it.
 */
export async function writeOutboxEvent(
  manager: EntityManager,
  fact: OutboxFact,
  occurredAt: Date,
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

/** An event a service publishes, named by its type, from which its writer finds the topic. */
export interface ServiceEvent<Type extends string> {
  readonly type: Type;
  /** The partition key: the id of the aggregate the event is about. */
  readonly key: string;
  readonly payload: Uint8Array;
  readonly traceparent: string | null;
}

export type OutboxWriter<Type extends string> = (
  manager: EntityManager,
  event: ServiceEvent<Type>,
  occurredAt: Date,
) => Promise<string>;

/**
 * A service's `writeOutboxEvent` over its table of each event type's aggregate type, which names the
 *   topic: a caller names the type, never the topic.
 */
export function outboxWriter<Type extends string>(
  topics: Readonly<Record<Type, string>>,
): OutboxWriter<Type> {
  return (manager, event, occurredAt) =>
    writeOutboxEvent(
      manager,
      {
        aggregateType: topics[event.type],
        aggregateId: event.key,
        type: event.type,
        payload: event.payload,
        traceparent: event.traceparent,
        // No verified actor while tokens are not verified (critical-rules #4): an unverified name
        // in a journal that decides money is worse than none.
        actorId: null,
      },
      occurredAt,
    );
}
