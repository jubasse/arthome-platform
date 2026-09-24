import { AccountRegisteredSchema } from '@arthome-platform/events';
import { fromBinary } from '@bufbuild/protobuf';
import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { Account } from './account.entity.js';
import { OutboxEvent } from './outbox-event.entity.js';
import { RegisterAccountService } from './register-account.service.js';

interface Insert {
  readonly target: unknown;
  readonly values: Record<string, unknown>;
  readonly manager: object;
}

/** A DataSource that records what was inserted, and through which manager. */
function recordingDataSource(inserts: Insert[]): DataSource {
  const manager = {
    insert: (target: unknown, values: Record<string, unknown>) => {
      inserts.push({ target, values, manager });
      return Promise.resolve();
    },
  };
  return {
    transaction: (run: (m: EntityManager) => Promise<unknown>) =>
      run(manager as unknown as EntityManager),
  } as unknown as DataSource;
}

const command = {
  publicHandle: '@marie.j',
  email: 'marie@example.test',
  locale: 'fr',
  country: 'FR',
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
};

describe('RegisterAccountService', () => {
  it('writes the account and the outbox row through ONE manager', async () => {
    const inserts: Insert[] = [];
    await new RegisterAccountService(recordingDataSource(inserts)).register(command);

    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.target).toBe(Account);
    expect(inserts[1]?.target).toBe(OutboxEvent);
    // The guarantee is not "both happened", it is "both happened in the same
    // transaction". A different manager here would mean two transactions, and
    // a crash between them loses the event or invents it.
    expect(inserts[0]?.manager).toBe(inserts[1]?.manager);
  });

  it('routes by aggregate, and keys by the account so one account stays ordered', async () => {
    const inserts: Insert[] = [];
    const result = await new RegisterAccountService(recordingDataSource(inserts)).register(command);
    const outbox = inserts[1]?.values ?? {};

    expect(outbox.aggregatetype).toBe('identity.account');
    expect(outbox.aggregateid).toBe(result.accountId);
    expect(outbox.type).toBe('identity.account.registered.v1');
  });

  it('injects the traceparent at WRITE time, not at publication time', async () => {
    const inserts: Insert[] = [];
    await new RegisterAccountService(recordingDataSource(inserts)).register(command);
    expect(inserts[1]?.values.tracecontext).toBe(command.traceparent);
  });

  it('carries no traceparent rather than inventing one', async () => {
    const inserts: Insert[] = [];
    await new RegisterAccountService(recordingDataSource(inserts)).register({
      ...command,
      traceparent: null,
    });
    expect(inserts[1]?.values.tracecontext).toBeNull();
  });

  it('writes a payload that decodes back to the event', async () => {
    const inserts: Insert[] = [];
    const result = await new RegisterAccountService(recordingDataSource(inserts)).register(command);

    const payload = inserts[1]?.values.payload as Buffer;
    const decoded = fromBinary(AccountRegisteredSchema, new Uint8Array(payload));
    expect(decoded.accountId).toBe(result.accountId);
    expect(decoded.locale).toBe('fr');
    expect(decoded.country).toBe('FR');
  });

  it('gives the message an identifier of its own, distinct from the account', async () => {
    const inserts: Insert[] = [];
    const result = await new RegisterAccountService(recordingDataSource(inserts)).register(command);
    // The message-id deduplicates deliveries; the account id identifies a
    // person. Reusing one for the other makes a second event about the same
    // account look like a duplicate of the first.
    expect(result.messageId).not.toBe(result.accountId);
    expect(inserts[1]?.values.id).toBe(result.messageId);
  });
});
