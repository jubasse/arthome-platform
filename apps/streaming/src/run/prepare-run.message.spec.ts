import { DateDraftedSchema } from '@arthome-platform/events';
import { Outcome, PermanentError } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { CommandBus } from '@nestjs/cqrs';
import type { EachMessagePayload } from 'kafkajs';
import { describe, expect, it } from 'vitest';

import { PrepareRun } from './prepare-run.command.js';
import { applyStreamingMessage } from '../consumed-messages.js';

const TOPIC = 'arthome.catalog.date';
const TYPE = 'catalog.date.drafted.v1';
const MESSAGE_ID = '01a0f1ee-0000-7000-8000-000000000001';
const KEY = '01a0f100-0000-7000-8000-000000000001';
const CHANNEL = '01a0f100-0000-7000-8000-0000000000c1';
const OCCURRED_AT = new Date('2026-09-29T10:00:00.000Z');

function delivered(value: Uint8Array): EachMessagePayload {
  return {
    topic: TOPIC,
    partition: 0,
    message: {
      key: Buffer.from(KEY),
      value: Buffer.from(value),
      headers: { 'message-id': Buffer.from(MESSAGE_ID), type: Buffer.from(TYPE) },
    },
  } as unknown as EachMessagePayload;
}

function recordingBus(executed: unknown[]): CommandBus {
  return {
    execute: (dispatched: unknown) => {
      executed.push(dispatched);
      return Promise.resolve(Outcome.APPLIED);
    },
  } as unknown as CommandBus;
}

describe(TYPE, () => {
  it('becomes PrepareRun, stated at its occurred_at', async () => {
    const executed: unknown[] = [];
    const value = toBinary(
      DateDraftedSchema,
      create(DateDraftedSchema, {
        dateId: KEY,
        channelId: CHANNEL,
        occurredAt: timestampFromDate(OCCURRED_AT),
      }),
    );

    expect(await applyStreamingMessage(recordingBus(executed), delivered(value))).toBe(
      Outcome.APPLIED,
    );
    expect(executed).toEqual([
      new PrepareRun(
        { messageId: MESSAGE_ID, topic: TOPIC, traceparent: null },
        { dateId: KEY, channelId: CHANNEL, occurredAt: OCCURRED_AT },
      ),
    ]);
  });

  it('is dead-lettered at once without an occurred_at, dispatching nothing', async () => {
    const executed: unknown[] = [];
    const value = toBinary(
      DateDraftedSchema,
      create(DateDraftedSchema, { dateId: KEY, channelId: CHANNEL }),
    );

    await expect(
      applyStreamingMessage(recordingBus(executed), delivered(value)),
    ).rejects.toBeInstanceOf(PermanentError);
    expect(executed).toEqual([]);
  });

  it('is dead-lettered at once when its channel is no UUID, dispatching nothing', async () => {
    const executed: unknown[] = [];
    const value = toBinary(
      DateDraftedSchema,
      create(DateDraftedSchema, { dateId: KEY, occurredAt: timestampFromDate(OCCURRED_AT) }),
    );

    await expect(
      applyStreamingMessage(recordingBus(executed), delivered(value)),
    ).rejects.toBeInstanceOf(PermanentError);
    expect(executed).toEqual([]);
  });
});
