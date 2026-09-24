import { AccountRegisteredSchema } from '@arthome-platform/events';
import { PermanentError, header, type Outcome } from '@arthome-platform/messaging';
import { fromBinary } from '@bufbuild/protobuf';
import type { EachMessagePayload } from 'kafkajs';
import type { DataSource } from 'typeorm';

import { ProcessedMessage } from './processed-message.entity.js';
import { WelcomeEmail } from './welcome-email.entity.js';

/**
 * Apply one message, exactly once, whatever the delivery does.
 *
 * ⚠ THE DEDUP INSERT AND THE BUSINESS WRITE SHARE ONE TRANSACTION AND ONE
 *   MANAGER. `orIgnore().returning('id')` returns no row when the identifier is
 *   already there, and that is the signal to skip — not a prior SELECT, which
 *   would leave a window in which two consumers both see nothing.
 *
 * ⚠ A MISSING `message-id` IS A PERMANENT ERROR, never a generated default.
 *   Inventing one would make the message undeduplicable and silently
 *   reprocessable for ever (events.md §1.3).
 */
export async function applyMessage(
  dataSource: DataSource,
  payload: EachMessagePayload,
): Promise<Outcome> {
  const messageId = header(payload, 'message-id');
  if (messageId === null) {
    // PERMANENT: no amount of waiting grows a header. And it cannot be given a
    // generated one — that would make the message undeduplicable and silently
    // reprocessable for ever (events.md §1.3).
    throw new PermanentError(
      `message on ${payload.topic} has no message-id header — permanent, not a default`,
    );
  }

  const type = header(payload, 'type');
  if (type !== 'identity.account.registered.v1') return 'ignored';

  const value = payload.message.value;
  if (value === null) throw new PermanentError(`message ${messageId} has no value`);

  let event;
  try {
    event = fromBinary(AccountRegisteredSchema, new Uint8Array(value));
  } catch (cause) {
    // PERMANENT: bytes that are not this schema will not become this schema.
    throw new PermanentError(
      `message ${messageId} does not decode as AccountRegistered: ${String(cause)}`,
    );
  }

  return dataSource.transaction(async (manager) => {
    const claimed = await manager
      .createQueryBuilder()
      .insert()
      .into(ProcessedMessage)
      .values({ id: messageId, topic: payload.topic })
      .orIgnore()
      .returning('id')
      .execute();

    if ((claimed.raw as unknown[]).length === 0) return 'duplicate';

    await manager.insert(WelcomeEmail, {
      account_id: event.accountId,
      locale: event.locale,
      country: event.country,
      traceparent: header(payload, 'traceparent'),
    });

    return 'applied';
  });
}
