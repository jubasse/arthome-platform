import { AccountRegisteredSchema } from '@arthome-platform/events';
import { fromBinary } from '@bufbuild/protobuf';
import type { EachMessagePayload } from 'kafkajs';
import type { DataSource } from 'typeorm';

import { ProcessedMessage } from './processed-message.entity.js';
import { WelcomeEmail } from './welcome-email.entity.js';

/** What the consumer did with a message, so a caller can assert on it. */
export type Outcome = 'applied' | 'duplicate' | 'ignored';

function header(payload: EachMessagePayload, name: string): string | null {
  const raw = payload.message.headers?.[name];
  if (raw === undefined || raw === null) return null;
  const value = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  // Debezium renders a NULL column as the four characters "null", not as an
  // absent header. Treating that as a value would store the string.
  return value === 'null' ? null : value;
}

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
    throw new Error(
      `message on ${payload.topic} has no message-id header — permanent error, not a default`,
    );
  }

  const type = header(payload, 'type');
  if (type !== 'identity.account.registered.v1') return 'ignored';

  const value = payload.message.value;
  if (value === null) throw new Error(`message ${messageId} has no value`);
  const event = fromBinary(AccountRegisteredSchema, new Uint8Array(value));

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
