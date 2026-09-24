import { AccountRegisteredSchema } from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EachMessagePayload } from 'kafkajs';
import type { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { applyMessage } from './account-consumer.js';
import { WelcomeEmail } from './welcome-email.entity.js';

const ACCOUNT_ID = '01a0d537-0abe-71f1-9ee1-d89eee348187';
const MESSAGE_ID = '01a0d537-0abe-71f1-9ee1-de46f259a23e';

function value(): Buffer {
  return Buffer.from(
    toBinary(
      AccountRegisteredSchema,
      create(AccountRegisteredSchema, {
        accountId: ACCOUNT_ID,
        occurredAt: timestampFromDate(new Date()),
        locale: 'fr',
        country: 'FR',
      }),
    ),
  );
}

function message(headers: Record<string, string>): EachMessagePayload {
  return {
    topic: 'arthome.identity.account',
    partition: 0,
    message: {
      key: Buffer.from(ACCOUNT_ID),
      value: value(),
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Buffer.from(v)])),
    },
  } as unknown as EachMessagePayload;
}

/** `claimed` decides whether the dedup insert reports a fresh identifier. */
function fakeDataSource(claimed: boolean, inserted: Record<string, unknown>[] = []): DataSource {
  const manager = {
    createQueryBuilder: () => ({
      insert: () => ({
        into: () => ({
          values: () => ({
            orIgnore: () => ({
              returning: () => ({
                execute: () => Promise.resolve({ raw: claimed ? [{ id: MESSAGE_ID }] : [] }),
              }),
            }),
          }),
        }),
      }),
    }),
    insert: (_target: unknown, values: Record<string, unknown>) => {
      inserted.push(values);
      return Promise.resolve();
    },
  };
  return {
    transaction: (run: (m: unknown) => Promise<unknown>) => run(manager),
  } as unknown as DataSource;
}

const headers = {
  'message-id': MESSAGE_ID,
  type: 'identity.account.registered.v1',
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
};

describe('applyMessage', () => {
  it('applies a message it has not seen', async () => {
    const inserted: Record<string, unknown>[] = [];
    const outcome = await applyMessage(fakeDataSource(true, inserted), message(headers));

    expect(outcome).toBe('applied');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.account_id).toBe(ACCOUNT_ID);
  });

  it('does NOT apply the effect a second time', async () => {
    const inserted: Record<string, unknown>[] = [];
    const outcome = await applyMessage(fakeDataSource(false, inserted), message(headers));

    // Delivery is at least once, always. The second arrival must change
    // nothing, and the dedup insert returning no row is what says so.
    expect(outcome).toBe('duplicate');
    expect(inserted).toHaveLength(0);
  });

  it('refuses a message with no message-id instead of inventing one', async () => {
    const { 'message-id': _omitted, ...withoutId } = headers;
    await expect(applyMessage(fakeDataSource(true), message(withoutId))).rejects.toThrow(
      /no message-id/,
    );
  });

  it('ignores a type it does not handle, without consuming the effect', async () => {
    const inserted: Record<string, unknown>[] = [];
    const outcome = await applyMessage(
      fakeDataSource(true, inserted),
      message({ ...headers, type: 'identity.device.revoked.v1' }),
    );
    expect(outcome).toBe('ignored');
    expect(inserted).toHaveLength(0);
  });

  it('reads Debezium’s literal "null" as absence, not as a value', async () => {
    const inserted: Record<string, unknown>[] = [];
    // Debezium renders a NULL column as the four characters `null`. Storing
    // that string is how a trace id becomes the word "null" in a dashboard.
    await applyMessage(
      fakeDataSource(true, inserted),
      message({ ...headers, traceparent: 'null' }),
    );
    expect(inserted[0]?.traceparent).toBeNull();
  });

  it('carries the traceparent into the effect it writes', async () => {
    const inserted: Record<string, unknown>[] = [];
    await applyMessage(fakeDataSource(true, inserted), message(headers));
    expect(inserted[0]?.traceparent).toBe(headers.traceparent);
  });
});

// Referenced so the entity import is not elided by verbatimModuleSyntax.
void WelcomeEmail;
