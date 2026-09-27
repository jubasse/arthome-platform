import type { EachMessagePayload } from 'kafkajs';
import { Column, Entity, PrimaryColumn, type EntityManager } from 'typeorm';

import { header } from './dispatch.js';
import { PermanentError } from './failure.js';

/**
 * Every consumer's deduplication ledger, inserted inside the business transaction so it cannot
 * roll back separately from the effect. A row means the effect committed; its absence means
 * "not known to have", never "known not to have", which is what makes replaying a topic safe.
 */
@Entity('processed_message')
export class ProcessedMessage {
  /** The `message-id` header: the outbox row's UUIDv7. */
  @PrimaryColumn('uuid')
  id!: string;

  @Column('text')
  topic!: string;

  @Column('timestamptz', { default: () => 'now()' })
  processed_at!: Date;
}

export function processedMessageTableDdl(): string {
  return `
    CREATE TABLE processed_message (
      id           uuid        PRIMARY KEY,
      topic        text        NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

/** The canonical text of a UUID, any version: what the outbox writes and `uuid` stores. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The key every claim is made on. Absent or not a UUID is permanent, never a generated default: a
 *   malformed id fails `processed_message.id` on every attempt, and was measured retried as
 *   transient for five minutes before reaching the dead-letter topic.
 */
export function messageIdOf(payload: EachMessagePayload): string {
  const messageId = header(payload, 'message-id');
  if (messageId === null) {
    throw new PermanentError(`message on ${payload.topic} has no message-id header`);
  }
  if (!UUID.test(messageId)) {
    throw new PermanentError(
      `message on ${payload.topic} has a message-id that is not a UUID: ${JSON.stringify(messageId.slice(0, 64))}`,
    );
  }
  return messageId;
}

/**
 * True the first time this message-id is seen, inside the caller's transaction, so the claim and
 *   the effect commit or roll back together. `ON CONFLICT DO NOTHING` rather than a prior SELECT,
 *   which leaves a window where two consumers both see nothing, or a caught 23505, which aborts
 *   the whole Postgres transaction.
 */
export async function claimMessage(
  manager: EntityManager,
  messageId: string,
  topic: string,
): Promise<boolean> {
  const inserted = await manager
    .createQueryBuilder()
    .insert()
    .into(ProcessedMessage)
    .values({ id: messageId, topic })
    .orIgnore()
    .returning('id')
    .execute();
  return (inserted.raw as unknown[]).length > 0;
}
