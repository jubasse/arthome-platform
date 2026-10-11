import {
  BlackoutReason,
  DateScheduledSchema,
  ReplayPolicy,
  RightsScope,
} from '@arthome-platform/events';
import { Outcome, PermanentError } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { CommandBus } from '@nestjs/cqrs';
import type { EachMessagePayload } from 'kafkajs';
import { describe, expect, it } from 'vitest';

import {
  BlackoutReason as Reason,
  ReplayPolicy as Policy,
  RightsScope as Scope,
} from '@arthome/core';

import { RecordDateFact } from './record-date-fact.command.js';
import { applyStreamingMessage } from '../consumed-messages.js';

const TOPIC = 'arthome.catalog.date';
const TYPE = 'catalog.date.scheduled.v1';
const MESSAGE_ID = '01a0f1ee-0000-7000-8000-000000000001';
const KEY = '01a0f100-0000-7000-8000-000000000001';
const OCCURRED_AT = new Date('2026-09-29T10:00:00.000Z');
const DELIVERY = { messageId: MESSAGE_ID, topic: TOPIC, traceparent: null };
const CHANNEL = '01a0f100-0000-7000-8000-0000000000c1';
const STARTS_AT = new Date('2026-12-12T19:00:00.000Z');

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
    startsAt: timestampFromDate(STARTS_AT),
    runtimeMin: 95,
    replayPolicy: ReplayPolicy.INCLUDED,
    replayWindowHours: 48,
    rights: {
      scope: RightsScope.RESTRICTED,
      blackoutCountries: ['be', 'CH'],
      reason: BlackoutReason.BROADCASTER,
    },
    occurredAt: timestampFromDate(OCCURRED_AT),
  };

  it('becomes RecordDateFact with its timing, replay and rights, stated at its occurred_at', async () => {
    const { executed } = await dispatched(
      toBinary(DateScheduledSchema, create(DateScheduledSchema, event)),
    );

    expect(executed).toEqual([
      new RecordDateFact(DELIVERY, {
        type: TYPE,
        dateId: KEY,
        channelId: CHANNEL,
        startsAt: STARTS_AT,
        runtimeMin: 95,
        replay: { policy: Policy.INCLUDED, windowHours: 48 },
        rights: {
          scope: Scope.RESTRICTED,
          blackoutCountries: ['BE', 'CH'],
          reason: Reason.BROADCASTER,
        },
        statedAt: OCCURRED_AT,
      }),
    ]);
  });

  it('fails closed on what it does not know: no replay, rights refused, a reason dropped', async () => {
    const { executed } = await dispatched(
      toBinary(
        DateScheduledSchema,
        create(DateScheduledSchema, {
          ...event,
          replayPolicy: 9 as ReplayPolicy,
          rights: {
            scope: 7 as RightsScope,
            blackoutCountries: ['BE'],
            reason: 8 as BlackoutReason,
          },
        }),
      ),
    );

    expect(executed).toEqual([
      expect.objectContaining({
        fact: expect.objectContaining({
          replay: { policy: Policy.NONE, windowHours: 48 },
          rights: { scope: null, blackoutCountries: ['BE'], reason: null },
        }) as unknown,
      }),
    ]);
  });

  it('reads absent rights as unknown, which refuses', async () => {
    const { executed } = await dispatched(
      toBinary(DateScheduledSchema, create(DateScheduledSchema, { ...event, rights: undefined })),
    );

    expect(executed).toEqual([
      expect.objectContaining({
        fact: expect.objectContaining({
          rights: { scope: null, blackoutCountries: [], reason: null },
        }) as unknown,
      }),
    ]);
  });

  it('is dead-lettered at once without its start or its occurred_at', async () => {
    await deadLettered(
      toBinary(DateScheduledSchema, create(DateScheduledSchema, { ...event, startsAt: undefined })),
    );
    await deadLettered(
      toBinary(
        DateScheduledSchema,
        create(DateScheduledSchema, { ...event, occurredAt: undefined }),
      ),
    );
  });
});
