import {
  ChatMode,
  DateChatPolicyChangedSchema,
  DateSalesPricingChangedSchema,
} from '@arthome-platform/events';
import { PermanentError } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EachMessagePayload } from 'kafkajs';
import type { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { applyChecklistMessage } from './checklist-consumer.js';

function message(type: string | null, value: Uint8Array | null, messageId: string | null = 'm-1') {
  const headers: Record<string, Buffer> = {};
  if (messageId !== null) headers['message-id'] = Buffer.from(messageId);
  if (type !== null) headers.type = Buffer.from(type);
  return {
    topic: 'arthome.ticketing.date_sales',
    partition: 0,
    message: {
      key: Buffer.from('date-1'),
      value: value === null ? null : Buffer.from(value),
      headers,
    },
  } as unknown as EachMessagePayload;
}

const untouchable = {
  transaction: () => {
    throw new Error('no transaction expected');
  },
} as unknown as DataSource;

describe('applyChecklistMessage, before any write', () => {
  it('ignores a type that says nothing about the checklist', async () => {
    await expect(
      applyChecklistMessage(
        untouchable,
        message('ticketing.seat.activated.v1', new Uint8Array([1])),
      ),
    ).resolves.toBe('ignored');
  });

  it('refuses a message with no message-id as permanent', () => {
    expect(() => applyChecklistMessage(untouchable, message('x.v1', null, null))).toThrow(
      PermanentError,
    );
  });

  it('refuses a fact with no occurred_at as permanent: an undated fact cannot be ordered', () => {
    const undated = toBinary(
      DateSalesPricingChangedSchema,
      create(DateSalesPricingChangedSchema, { dateId: 'date-1' }),
    );
    expect(() =>
      applyChecklistMessage(
        untouchable,
        message('ticketing.date_sales.pricing_changed.v1', undated),
      ),
    ).toThrow(PermanentError);
  });

  it('reads a chat policy with a mode as a satisfied item, all the way to the write', async () => {
    const policy = toBinary(
      DateChatPolicyChangedSchema,
      create(DateChatPolicyChangedSchema, {
        dateId: 'date-1',
        mode: ChatMode.OPEN,
        occurredAt: timestampFromDate(new Date('2026-09-26T10:00:00.000Z')),
      }),
    );
    const reachedTheWrite = {
      transaction: () => Promise.resolve('applied'),
    } as unknown as DataSource;
    await expect(
      applyChecklistMessage(reachedTheWrite, message('chat.date_chat_policy.changed.v1', policy)),
    ).resolves.toBe('applied');
  });
});
