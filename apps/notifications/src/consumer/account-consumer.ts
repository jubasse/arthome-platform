import { AccountRegisteredSchema } from '@arthome-platform/events';
import {
  Outcome,
  PermanentError,
  claimMessage,
  header,
  messageIdOf,
} from '@arthome-platform/messaging';
import { fromBinary } from '@bufbuild/protobuf';
import type { EachMessagePayload } from 'kafkajs';
import type { DataSource } from 'typeorm';

import { WelcomeEmail } from './welcome-email.entity.js';

export async function applyMessage(
  dataSource: DataSource,
  payload: EachMessagePayload,
): Promise<Outcome> {
  const messageId = messageIdOf(payload);

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
    if (!(await claimMessage(manager, messageId, payload.topic))) return Outcome.DUPLICATE;

    /**
     * `orIgnore()` because the two guards answer different questions: the dedup claim above
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

    return (written.raw as unknown[]).length === 0 ? Outcome.DUPLICATE : Outcome.APPLIED;
  });
}
