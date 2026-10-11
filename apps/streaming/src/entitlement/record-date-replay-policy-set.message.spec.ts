import { DateReplayPolicySetSchema, ReplayPolicy } from '@arthome-platform/events';
import { Outcome, PermanentError } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { CommandBus } from '@nestjs/cqrs';
import type { EachMessagePayload } from 'kafkajs';
import { describe, expect, it } from 'vitest';

import { ReplayPolicy as Policy } from '@arthome/core';

import { RecordDateFact } from './record-date-fact.command.js';
import { applyStreamingMessage } from '../consumed-messages.js';

const TOPIC = 'arthome.catalog.date';
const TYPE = 'catalog.date.replay_policy_set.v1';
const MESSAGE_ID = '01a0f1ee-0000-7000-8000-000000000001';
const KEY = '01a0f100-0000-7000-8000-000000000001';
const OCCURRED_AT = new Date('2026-09-29T10:00:00.000Z');
const DELIVERY = { messageId: MESSAGE_ID, topic: TOPIC, traceparent: null };

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

async function dispatched(value: Uint8Array): Promise<{ outcome: Outcome; executed: unknown[] }> {
  const executed: unknown[] = [];
  const bus = {
    execute: (command: unknown) => {
      executed.push(command);
      return Promise.resolve(Outcome.APPLIED);
    },
  } as unknown as CommandBus;
  return { outcome: await applyStreamingMessage(bus, delivered(value)), executed };
}

async function deadLettered(value: Uint8Array): Promise<void> {
  const executed: unknown[] = [];
  const bus = { execute: (command: unknown) => executed.push(command) } as unknown as CommandBus;
  await expect(applyStreamingMessage(bus, delivered(value))).rejects.toBeInstanceOf(PermanentError);
  expect(executed).toEqual([]);
}

describe(TYPE, () => {
  const event = {
    dateId: KEY,
    policy: ReplayPolicy.SUBSCRIPTION,
    windowHours: 72,
    occurredAt: timestampFromDate(OCCURRED_AT),
  };

  it('becomes RecordDateFact with its policy and window, stated at its occurred_at', async () => {
    const { executed } = await dispatched(
      toBinary(DateReplayPolicySetSchema, create(DateReplayPolicySetSchema, event)),
    );

    expect(executed).toEqual([
      new RecordDateFact(DELIVERY, {
        type: TYPE,
        dateId: KEY,
        replay: { policy: Policy.SUBSCRIPTION, windowHours: 72 },
        statedAt: OCCURRED_AT,
      }),
    ]);
  });

  it('reads a policy this build does not know as none', async () => {
    const { executed } = await dispatched(
      toBinary(
        DateReplayPolicySetSchema,
        create(DateReplayPolicySetSchema, { ...event, policy: ReplayPolicy.UNSPECIFIED }),
      ),
    );

    expect(executed).toEqual([
      expect.objectContaining({
        fact: expect.objectContaining({
          replay: { policy: Policy.NONE, windowHours: 72 },
        }) as unknown,
      }),
    ]);
  });

  it('is dead-lettered at once without an occurred_at', async () => {
    await deadLettered(
      toBinary(
        DateReplayPolicySetSchema,
        create(DateReplayPolicySetSchema, { ...event, occurredAt: undefined }),
      ),
    );
  });
});
