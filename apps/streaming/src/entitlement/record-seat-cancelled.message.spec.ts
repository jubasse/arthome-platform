import { SeatCancelReason, SeatCancelledSchema } from '@arthome-platform/events';
import { Outcome, PermanentError } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { CommandBus } from '@nestjs/cqrs';
import type { EachMessagePayload } from 'kafkajs';
import { describe, expect, it } from 'vitest';

import { RecordSeatFact } from './record-seat-fact.command.js';
import { applyStreamingMessage } from '../consumed-messages.js';

const TOPIC = 'arthome.ticketing.date_sales';
const TYPE = 'ticketing.seat.cancelled.v1';
const MESSAGE_ID = '01a0f1ee-0000-7000-8000-000000000001';
const KEY = '01a0f100-0000-7000-8000-000000000001';
const OCCURRED_AT = new Date('2026-09-29T10:00:00.000Z');
const DELIVERY = { messageId: MESSAGE_ID, topic: TOPIC, traceparent: null };
const ACCOUNT = '01a0f100-0000-7000-8000-0000000000a1';
const SEAT = '01a0f100-0000-7000-8000-0000000000e1';

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
    seatId: SEAT,
    accountId: ACCOUNT,
    dateId: KEY,
    occurredAt: timestampFromDate(OCCURRED_AT),
  };

  it('becomes RecordSeatFact, stated at its occurred_at', async () => {
    const { outcome, executed } = await dispatched(
      toBinary(SeatCancelledSchema, create(SeatCancelledSchema, event)),
    );

    expect(outcome).toBe(Outcome.APPLIED);
    expect(executed).toEqual([
      new RecordSeatFact(DELIVERY, {
        type: TYPE,
        seatId: SEAT,
        accountId: ACCOUNT,
        dateId: KEY,
        statedAt: OCCURRED_AT,
      }),
    ]);
  });

  it('cancels whatever its reason, one this build does not know included', async () => {
    for (const reason of [SeatCancelReason.VIEWER_REQUEST, 99 as SeatCancelReason]) {
      const { executed } = await dispatched(
        toBinary(SeatCancelledSchema, create(SeatCancelledSchema, { ...event, reason })),
      );
      expect(executed).toHaveLength(1);
    }
  });

  it('reads without an account, a date or an occurred_at, which the kept row holds', async () => {
    const { executed } = await dispatched(
      toBinary(SeatCancelledSchema, create(SeatCancelledSchema, { seatId: SEAT, accountId: '' })),
    );

    expect(executed).toEqual([
      new RecordSeatFact(DELIVERY, { type: TYPE, seatId: SEAT, statedAt: null }),
    ]);
  });

  it('is dead-lettered at once without a seat, or with bytes of another type', async () => {
    await deadLettered(
      toBinary(SeatCancelledSchema, create(SeatCancelledSchema, { ...event, seatId: '' })),
    );
    await deadLettered(Uint8Array.of(0xff, 0xff, 0xff));
  });
});
