import {
  ChatMode,
  DateChatPolicyChangedSchema,
  DateSalesPricingChangedSchema,
} from '@arthome-platform/events';
import {
  ATTEMPT_HEADER,
  PermanentError,
  deadLetterTopic,
  dispatch,
  retryTopic,
} from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { CommandBus } from '@nestjs/cqrs';
import type { EachMessagePayload, Producer, ProducerRecord } from 'kafkajs';
import { describe, expect, it } from 'vitest';

import { DomainError, DomainErrorCode, Service } from '@arthome/core';

import { applyChecklistMessage } from './checklist-consumer.js';

const MESSAGE_ID = '01a0e5bb-0000-7000-8000-000000000001';

function message(
  type: string | null,
  value: Uint8Array | null,
  messageId: string | null = MESSAGE_ID,
) {
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
  execute: () => {
    throw new Error('no command expected');
  },
} as unknown as CommandBus;

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

  it('dead-letters a message-id that is not a UUID at once, before any command', async () => {
    const sent: ProducerRecord[] = [];
    const producer = {
      send: (record: ProducerRecord) => {
        sent.push(record);
        return Promise.resolve([]);
      },
    } as unknown as Producer;

    const policy = toBinary(
      DateChatPolicyChangedSchema,
      create(DateChatPolicyChangedSchema, {
        dateId: 'date-1',
        mode: ChatMode.OPEN,
        occurredAt: timestampFromDate(new Date('2026-09-26T10:00:00.000Z')),
      }),
    );

    const disposition = await dispatch(
      (payload) => applyChecklistMessage(untouchable, payload),
      producer,
      Service.CATALOG,
      message('chat.date_chat_policy.changed.v1', policy, 'm-1'),
      new Date(),
    );

    expect(disposition).toBe('dead-lettered');
    expect(sent.map((record) => record.topic)).toEqual([deadLetterTopic(Service.CATALOG)]);
    expect(sent[0]?.messages[0]?.headers?.[ATTEMPT_HEADER]).toBe('0');
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
      execute: () => Promise.resolve('applied'),
    } as unknown as CommandBus;
    await expect(
      applyChecklistMessage(reachedTheWrite, message('chat.date_chat_policy.changed.v1', policy)),
    ).resolves.toBe('applied');
  });

  it('retries what the bus fails with, short of a refusal, as transient', async () => {
    const sent: ProducerRecord[] = [];
    const producer = {
      send: (record: ProducerRecord) => {
        sent.push(record);
        return Promise.resolve([]);
      },
    } as unknown as Producer;
    const unreachable = {
      execute: () => Promise.reject(new Error('Connection terminated unexpectedly')),
    } as unknown as CommandBus;
    const policy = toBinary(
      DateChatPolicyChangedSchema,
      create(DateChatPolicyChangedSchema, {
        dateId: 'date-1',
        mode: ChatMode.OPEN,
        occurredAt: timestampFromDate(new Date('2026-09-26T10:00:00.000Z')),
      }),
    );

    const disposition = await dispatch(
      (payload) => applyChecklistMessage(unreachable, payload),
      producer,
      Service.CATALOG,
      message('chat.date_chat_policy.changed.v1', policy),
      new Date(),
    );

    expect(disposition).toBe('retried');
    expect(sent.map((record) => record.topic)).toEqual([retryTopic(Service.CATALOG)]);
    expect(sent[0]?.messages[0]?.headers?.[ATTEMPT_HEADER]).toBe('1');
  });

  it('dead-letters a refusal other than an unknown date under its code, not as unknown', async () => {
    const refusing = {
      execute: () =>
        Promise.reject(
          new DomainError({ code: DomainErrorCode.STATE_CONFLICT, params: { currentVersion: 1 } }),
        ),
    } as unknown as CommandBus;
    const policy = toBinary(
      DateChatPolicyChangedSchema,
      create(DateChatPolicyChangedSchema, {
        dateId: 'date-1',
        mode: ChatMode.OPEN,
        occurredAt: timestampFromDate(new Date('2026-09-26T10:00:00.000Z')),
      }),
    );

    await expect(
      applyChecklistMessage(refusing, message('chat.date_chat_policy.changed.v1', policy)),
    ).rejects.toThrow(`message ${MESSAGE_ID} is about date date-1, refused state.conflict`);
  });
});
