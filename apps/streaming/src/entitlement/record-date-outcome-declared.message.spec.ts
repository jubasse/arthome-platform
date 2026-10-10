import { DateOutcome, DateOutcomeDeclaredSchema } from '@arthome-platform/events';
import { Outcome, PermanentError } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { CommandBus } from '@nestjs/cqrs';
import type { EachMessagePayload } from 'kafkajs';
import { describe, expect, it } from 'vitest';

import { DateOutcome as Outcomes } from '@arthome/core';

import { RecordDateFact } from './record-date-fact.command.js';
import { applyStreamingMessage } from '../consumed-messages.js';

const TOPIC = 'arthome.catalog.date';
const TYPE = 'catalog.date.outcome_declared.v1';
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
    outcome: DateOutcome.CANCELLED,
    declaredAt: timestampFromDate(OCCURRED_AT),
  };

  it('becomes RecordDateFact, stated at its declared_at', async () => {
    const { executed } = await dispatched(
      toBinary(DateOutcomeDeclaredSchema, create(DateOutcomeDeclaredSchema, event)),
    );

    expect(executed).toEqual([
      new RecordDateFact(DELIVERY, {
        type: TYPE,
        dateId: KEY,
        channelId: CHANNEL,
        outcome: Outcomes.CANCELLED,
        statedAt: OCCURRED_AT,
      }),
    ]);
  });

  it('ignores an outcome this build does not know, as ticketing does', async () => {
    const { outcome, executed } = await dispatched(
      toBinary(
        DateOutcomeDeclaredSchema,
        create(DateOutcomeDeclaredSchema, { ...event, outcome: 9 as DateOutcome }),
      ),
    );

    expect(outcome).toBe(Outcome.IGNORED);
    expect(executed).toEqual([]);
  });

  it('is dead-lettered at once without its declared_at', async () => {
    await deadLettered(
      toBinary(
        DateOutcomeDeclaredSchema,
        create(DateOutcomeDeclaredSchema, { ...event, declaredAt: undefined }),
      ),
    );
  });
});
