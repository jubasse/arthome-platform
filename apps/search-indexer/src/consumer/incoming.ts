import { PermanentError, header, messageIdOf } from '@arthome-platform/messaging';
import type { EachMessagePayload } from 'kafkajs';

export interface Incoming {
  readonly messageId: string;
  readonly type: string | null;
  readonly traceparent: string | null;
}

export function incomingOf(payload: EachMessagePayload): Incoming {
  return {
    messageId: messageIdOf(payload),
    type: header(payload, 'type'),
    traceparent: header(payload, 'traceparent'),
  };
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
