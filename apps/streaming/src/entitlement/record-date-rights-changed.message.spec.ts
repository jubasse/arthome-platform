import { DateRightsChangedSchema, RightsScope } from '@arthome-platform/events';
import { Outcome, PermanentError } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { CommandBus } from '@nestjs/cqrs';
import type { EachMessagePayload } from 'kafkajs';
import { describe, expect, it } from 'vitest';

import { RightsScope as Scope } from '@arthome/core';

import { RecordDateFact } from './record-date-fact.command.js';
import { applyStreamingMessage } from '../consumed-messages.js';

const TOPIC = 'arthome.catalog.date';
const TYPE = 'catalog.date.rights_changed.v1';
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
    rights: { scope: RightsScope.WORLDWIDE },
    occurredAt: timestampFromDate(OCCURRED_AT),
  };

  it('becomes RecordDateFact with its rights, stated at its occurred_at', async () => {
    const { executed } = await dispatched(
      toBinary(DateRightsChangedSchema, create(DateRightsChangedSchema, event)),
    );

    expect(executed).toEqual([
      new RecordDateFact(DELIVERY, {
        type: TYPE,
        dateId: KEY,
        rights: { scope: Scope.WORLDWIDE, blackoutCountries: [], reason: null },
        statedAt: OCCURRED_AT,
      }),
    ]);
  });

  it('reads a scope this build does not know as null, which refuses', async () => {
    const { executed } = await dispatched(
      toBinary(
        DateRightsChangedSchema,
        create(DateRightsChangedSchema, { ...event, rights: { scope: 5 as RightsScope } }),
      ),
    );

    expect(executed).toEqual([
      expect.objectContaining({
        fact: expect.objectContaining({
          rights: { scope: null, blackoutCountries: [], reason: null },
        }) as unknown,
      }),
    ]);
  });

  it('is dead-lettered at once without an occurred_at, or about a date that is not a UUID', async () => {
    await deadLettered(
      toBinary(
        DateRightsChangedSchema,
        create(DateRightsChangedSchema, { ...event, occurredAt: undefined }),
      ),
    );
    await deadLettered(
      toBinary(
        DateRightsChangedSchema,
        create(DateRightsChangedSchema, { ...event, dateId: 'date-1' }),
      ),
    );
  });
});
