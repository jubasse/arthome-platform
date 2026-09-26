import { PermanentError, ProcessedMessage, header } from '@arthome-platform/messaging';
import type { EachMessagePayload } from 'kafkajs';
import type { EntityManager } from 'typeorm';

export interface Incoming {
  readonly messageId: string;
  readonly type: string | null;
  readonly traceparent: string | null;
}

/** A message with no message-id is undeduplicable, so it is refused rather than given one. */
export function incomingOf(payload: EachMessagePayload): Incoming {
  const messageId = header(payload, 'message-id');
  if (messageId === null) {
    throw new PermanentError(`message on ${payload.topic} has no message-id header`);
  }
  return { messageId, type: header(payload, 'type'), traceparent: header(payload, 'traceparent') };
}

/** Bytes that are not the named schema will not become it on a retry. */
export function decodedOrRefused<T>(
  payload: EachMessagePayload,
  incoming: Incoming,
  decode: (value: Uint8Array) => T,
): T {
  const value = payload.message.value;
  if (value === null) throw new PermanentError(`message ${incoming.messageId} has no value`);
  try {
    return decode(new Uint8Array(value));
  } catch (cause) {
    throw new PermanentError(
      `message ${incoming.messageId} does not read as ${incoming.type ?? 'its type'}: ${String(cause)}`,
    );
  }
}

/** True the first time this message-id is seen, inside the caller's transaction. */
export async function claimed(
  manager: EntityManager,
  incoming: Incoming,
  topic: string,
): Promise<boolean> {
  const inserted = await manager
    .createQueryBuilder()
    .insert()
    .into(ProcessedMessage)
    .values({ id: incoming.messageId, topic })
    .orIgnore()
    .returning('id')
    .execute();
  return (inserted.raw as unknown[]).length > 0;
}
