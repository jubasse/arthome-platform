import {
  PlanOpening,
  PlanTier,
  SubscriptionChangedSchema,
  SubscriptionState,
} from '@arthome-platform/events';
import { Outcome, PermanentError } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { CommandBus } from '@nestjs/cqrs';
import type { EachMessagePayload } from 'kafkajs';
import { describe, expect, it } from 'vitest';

import {
  PlanOpening as Opening,
  PlanTier as Tier,
  SubscriptionState as State,
} from '@arthome/core';

import { RecordSubscriptionFact } from './record-subscription-fact.command.js';
import { applyStreamingMessage } from '../consumed-messages.js';

const TOPIC = 'arthome.ticketing.account';
const TYPE = 'ticketing.subscription.changed.v1';
const MESSAGE_ID = '01a0f1ee-0000-7000-8000-000000000001';
const KEY = '01a0f100-0000-7000-8000-0000000000a1';
const OCCURRED_AT = new Date('2026-09-29T10:00:00.000Z');
const DELIVERY = { messageId: MESSAGE_ID, topic: TOPIC, traceparent: null };
const PAID_THROUGH = new Date('2026-10-29T10:00:00.000Z');

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
    accountId: KEY,
    plan: PlanTier.PREMIUM,
    state: SubscriptionState.PAST_DUE,
    opens: [PlanOpening.ALL_LIVES, PlanOpening.MULTI_SCREEN],
    concurrentStreamsAllowed: 2,
    currentPeriodEnd: timestampFromDate(new Date('2026-11-29T10:00:00.000Z')),
    paidThrough: timestampFromDate(PAID_THROUGH),
    occurredAt: timestampFromDate(OCCURRED_AT),
  };

  it('becomes RecordSubscriptionFact, paid through the end of the last paid period', async () => {
    const { executed } = await dispatched(
      toBinary(SubscriptionChangedSchema, create(SubscriptionChangedSchema, event)),
    );

    expect(executed).toEqual([
      new RecordSubscriptionFact(DELIVERY, {
        type: TYPE,
        accountId: KEY,
        plan: Tier.PREMIUM,
        state: State.PAST_DUE,
        openings: [Opening.ALL_LIVES, Opening.MULTI_SCREEN],
        paidThrough: PAID_THROUGH,
        statedAt: OCCURRED_AT,
      }),
    ]);
  });

  it('keeps out what this build does not know: an opening dropped, a state and a plan null', async () => {
    const { executed } = await dispatched(
      toBinary(
        SubscriptionChangedSchema,
        create(SubscriptionChangedSchema, {
          ...event,
          plan: 42 as PlanTier,
          state: SubscriptionState.UNSPECIFIED,
          opens: [PlanOpening.ALL_LIVES, 77 as PlanOpening, PlanOpening.UNSPECIFIED],
          paidThrough: undefined,
        }),
      ),
    );

    expect(executed).toEqual([
      new RecordSubscriptionFact(DELIVERY, {
        type: TYPE,
        accountId: KEY,
        plan: null,
        state: null,
        openings: [Opening.ALL_LIVES],
        paidThrough: null,
        statedAt: OCCURRED_AT,
      }),
    ]);
  });

  it('is dead-lettered at once with an empty account or without an occurred_at', async () => {
    await deadLettered(
      toBinary(
        SubscriptionChangedSchema,
        create(SubscriptionChangedSchema, { ...event, accountId: '' }),
      ),
    );
    await deadLettered(
      toBinary(
        SubscriptionChangedSchema,
        create(SubscriptionChangedSchema, { ...event, occurredAt: undefined }),
      ),
    );
  });
});
