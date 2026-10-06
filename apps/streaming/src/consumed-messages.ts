import { Outcome, PermanentError, header, messageIdOf } from '@arthome-platform/messaging';
import type { Command, CommandBus } from '@nestjs/cqrs';
import type { EachMessagePayload } from 'kafkajs';

import { ApiErrorCode, isDomainError } from '@arthome/core';

import type { Delivery } from './delivery.js';

type Reader = (value: Uint8Array, delivery: Delivery) => Command<Outcome>;

/** The command each consumed type becomes; a type absent here is not streaming's, and ignored. */
const READERS: Readonly<Record<string, Reader>> = {};

/**
 * One message read as its command. Bytes that do not read as their type, and a refusal no retry
 *   changes, are permanent: dead-lettered at once. Anything else is retried as transient.
 */
export async function applyStreamingMessage(
  commands: CommandBus,
  payload: EachMessagePayload,
): Promise<Outcome> {
  const messageId = messageIdOf(payload);
  const type = header(payload, 'type');
  const read = type === null ? undefined : READERS[type];
  if (read === undefined) return Outcome.IGNORED;

  const value = payload.message.value;
  if (value === null) throw new PermanentError(`message ${messageId} has no value`);
  const delivery: Delivery = {
    messageId,
    topic: payload.topic,
    traceparent: header(payload, 'traceparent'),
  };
  let command: Command<Outcome>;
  try {
    command = read(new Uint8Array(value), delivery);
  } catch (cause) {
    throw new PermanentError(`message ${messageId} does not read as ${type}: ${String(cause)}`, {
      cause,
    });
  }

  try {
    return await commands.execute(command);
  } catch (error) {
    if (!isDomainError(error)) throw error;
    const refusal =
      error.code === ApiErrorCode.NOT_FOUND ? 'unknown here' : `refused ${error.code}`;
    throw new PermanentError(`message ${messageId} (${type}), ${refusal}`, { cause: error });
  }
}
