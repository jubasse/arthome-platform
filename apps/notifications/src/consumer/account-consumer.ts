import { AccountRegisteredSchema } from '@arthome-platform/events';
import {
  header,
  type Outcome,
  PermanentError,
  ProcessedMessage,
} from '@arthome-platform/messaging';
import { fromBinary } from '@bufbuild/protobuf';
import type { EachMessagePayload } from 'kafkajs';
import type { DataSource } from 'typeorm';

import { WelcomeEmail } from './welcome-email.entity.js';

/**
 * The dedup insert and the business write share one transaction and one manager.
 *   `orIgnore().returning('id')` returns no row when the identifier is already there, and
 *   that is the signal to skip — not a prior SELECT, which would leave a window in which two
 *   consumers both see nothing.
 * A missing `message-id` is a permanent error, never a generated default: inventing one
 *   would make the message undeduplicable and silently reprocessable for ever (§1.3).
 */
export async function applyMessage(
  dataSource: DataSource,
  payload: EachMessagePayload,
): Promise<Outcome> {
  const messageId = header(payload, 'message-id');
  if (messageId === null) {
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
    // Permanent: bytes that are not this schema will not become this schema.
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

    /**
     * `orIgnore()` because the two guards answer different questions: the dedup insert above
     *   answers "have I seen this MESSAGE", `welcome_email`'s primary key answers "does this
     *   ACCOUNT already have one". Two `message-id`s carrying one account pass the first and
     *   violate the second.
     * Measured against Postgres 18: a bare insert raises 23505 and poisons the whole
     *   transaction, dedup claim included — every later statement gets `current transaction is
     *   aborted`, so the `message-id` is never recorded and each retry redoes all of it.
     *   `ON CONFLICT DO NOTHING RETURNING` returns no row and leaves the transaction usable.
     */
    const written = await manager
      .createQueryBuilder()
      .insert()
      .into(WelcomeEmail)
      .values({
        account_id: event.accountId,
        locale: event.locale,
        country: event.country,
        traceparent: header(payload, 'traceparent'),
      })
      .orIgnore()
      .returning('account_id')
      .execute();

    return (written.raw as unknown[]).length === 0 ? 'duplicate' : 'applied';
  });
}
