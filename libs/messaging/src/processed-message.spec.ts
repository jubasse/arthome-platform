import type { EachMessagePayload, Producer, ProducerRecord } from 'kafkajs';
import { describe, expect, it } from 'vitest';

import { Service } from '@arthome/core';

import { ATTEMPT_HEADER, DLQ_REASON_HEADER, dispatch } from './dispatch.js';
import { PermanentError, deadLetterTopic } from './failure.js';
import { messageIdOf } from './processed-message.js';

const MESSAGE_ID = '01a0e5aa-0000-7000-8000-000000000001';

function message(messageId: string | undefined): EachMessagePayload {
  return {
    topic: 'arthome.catalog.show',
    partition: 0,
    message: {
      key: Buffer.from('show-1'),
      value: Buffer.from([1]),
      headers: messageId === undefined ? {} : { 'message-id': Buffer.from(messageId) },
    },
  } as unknown as EachMessagePayload;
}

describe('messageIdOf', () => {
  it('reads a UUID, whatever its version', () => {
    expect(messageIdOf(message(MESSAGE_ID))).toBe(MESSAGE_ID);
    expect(messageIdOf(message('00000000-0000-0000-0000-000000000001'))).toBe(
      '00000000-0000-0000-0000-000000000001',
    );
  });

  it.each([
    ['no header', undefined, /no message-id/],
    ['the word Debezium writes for a NULL column', 'null', /no message-id/],
    ['an id that is not a UUID', 'm-1', /not a UUID: "m-1"/],
    ['a UUID with something after it', `${MESSAGE_ID}x`, /not a UUID/],
  ])('refuses %s as permanent', (_, messageId, reason) => {
    expect(() => messageIdOf(message(messageId))).toThrow(PermanentError);
    expect(() => messageIdOf(message(messageId))).toThrow(reason);
  });

  it('dead-letters a malformed id at attempt 0, never through the retry topic', async () => {
    const sent: ProducerRecord[] = [];
    const producer = {
      send: (record: ProducerRecord) => {
        sent.push(record);
        return Promise.resolve([]);
      },
    } as unknown as Producer;

    const disposition = await dispatch(
      (payload) => {
        messageIdOf(payload);
        return Promise.resolve('applied');
      },
      producer,
      Service.CATALOG,
      message('m-1'),
      new Date(),
    );

    expect(disposition).toBe('dead-lettered');
    expect(sent.map((record) => record.topic)).toEqual([deadLetterTopic(Service.CATALOG)]);
    expect(sent[0]?.messages[0]?.headers).toMatchObject({
      [ATTEMPT_HEADER]: '0',
      [DLQ_REASON_HEADER]: 'permanent',
    });
  });
});
