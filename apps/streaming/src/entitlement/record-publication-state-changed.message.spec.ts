import { PublicationState, PublicationStateChangedSchema } from '@arthome-platform/events';
import { Outcome, PermanentError } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { CommandBus } from '@nestjs/cqrs';
import type { EachMessagePayload } from 'kafkajs';
import { describe, expect, it } from 'vitest';

import { PublicationState as State } from '@arthome/core';

import { RecordDateFact } from './record-date-fact.command.js';
import { applyStreamingMessage } from '../consumed-messages.js';

const TOPIC = 'arthome.catalog.date';
const TYPE = 'catalog.publication.state_changed.v1';
const MESSAGE_ID = '01a0f1ee-0000-7000-8000-000000000001';
const KEY = '01a0f100-0000-7000-8000-000000000001';
const OCCURRED_AT = new Date('2026-09-29T10:00:00.000Z');
const DELIVERY = { messageId: MESSAGE_ID, topic: TOPIC, traceparent: null };
const CHANNEL = '01a0f100-0000-7000-8000-0000000000c1';

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
    channelId: CHANNEL,
    fromState: PublicationState.RESERVE,
    toState: PublicationState.SCHEDULED,
    version: 4n,
    occurredAt: timestampFromDate(OCCURRED_AT),
  };

  it("becomes RecordDateFact with the state it moved to and catalog's version", async () => {
    const { executed } = await dispatched(
      toBinary(PublicationStateChangedSchema, create(PublicationStateChangedSchema, event)),
    );

    expect(executed).toEqual([
      new RecordDateFact(DELIVERY, {
        type: TYPE,
        dateId: KEY,
        channelId: CHANNEL,
        state: State.SCHEDULED,
        version: 4n,
        statedAt: OCCURRED_AT,
      }),
    ]);
  });

  it('reads a state this build does not know as null, which refuses', async () => {
    const { executed } = await dispatched(
      toBinary(
        PublicationStateChangedSchema,
        create(PublicationStateChangedSchema, { ...event, toState: 12 as PublicationState }),
      ),
    );

    expect(executed).toEqual([
      expect.objectContaining({ fact: expect.objectContaining({ state: null }) as unknown }),
    ]);
  });

  it('is dead-lettered at once without an occurred_at', async () => {
    await deadLettered(
      toBinary(
        PublicationStateChangedSchema,
        create(PublicationStateChangedSchema, { ...event, occurredAt: undefined }),
      ),
    );
  });
});
