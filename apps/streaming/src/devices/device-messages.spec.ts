import { DeviceRevokedSchema, DeviceSessionClosedSchema } from '@arthome-platform/events';
import { Outcome, PermanentError } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { CommandBus } from '@nestjs/cqrs';
import type { EachMessagePayload } from 'kafkajs';
import { describe, expect, it } from 'vitest';

import { RevokeDeviceLeases } from './revoke-device-leases.command.js';
import { RevokeProfileLeases } from './revoke-profile-leases.command.js';
import { applyStreamingMessage } from '../consumed-messages.js';

const TOPIC = 'arthome.identity.device';
const REVOKED = 'identity.device.revoked.v1';
const CLOSED = 'identity.device_session.closed.v1';
const MESSAGE_ID = '01a0f1ee-0000-7000-8000-000000000001';
const DEVICE = '01a0f100-0000-7000-8000-000000000001';
const ACCOUNT = '01a0f101-0000-7000-8000-000000000001';
const PROFILE = '01a0f102-0000-7000-8000-000000000001';
const OCCURRED_AT = new Date('2026-09-29T10:00:00.000Z');
const DELIVERY = { messageId: MESSAGE_ID, topic: TOPIC, traceparent: null };

function delivered(type: string, value: Uint8Array): EachMessagePayload {
  return {
    topic: TOPIC,
    partition: 0,
    message: {
      key: Buffer.from(DEVICE),
      value: Buffer.from(value),
      headers: { 'message-id': Buffer.from(MESSAGE_ID), type: Buffer.from(type) },
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

const revoked = (init: Parameters<typeof create<typeof DeviceRevokedSchema>>[1]) =>
  toBinary(DeviceRevokedSchema, create(DeviceRevokedSchema, init));

const closed = (init: Parameters<typeof create<typeof DeviceSessionClosedSchema>>[1]) =>
  toBinary(DeviceSessionClosedSchema, create(DeviceSessionClosedSchema, init));

describe(REVOKED, () => {
  it("becomes RevokeDeviceLeases for the account's device", async () => {
    const executed: unknown[] = [];
    const value = revoked({
      deviceId: DEVICE,
      accountId: ACCOUNT,
      occurredAt: timestampFromDate(OCCURRED_AT),
    });
    expect(await applyStreamingMessage(recordingBus(executed), delivered(REVOKED, value))).toBe(
      Outcome.APPLIED,
    );
    expect(executed).toEqual([
      new RevokeDeviceLeases(DELIVERY, {
        accountId: ACCOUNT,
        deviceId: DEVICE,
        occurredAt: OCCURRED_AT,
      }),
    ]);
  });

  it.each([
    ['without an occurred_at', { deviceId: DEVICE, accountId: ACCOUNT }],
    [
      'with an empty account',
      { deviceId: DEVICE, accountId: '', occurredAt: timestampFromDate(OCCURRED_AT) },
    ],
  ])('is dead-lettered at once %s, dispatching nothing', async (_case, init) => {
    const executed: unknown[] = [];
    await expect(
      applyStreamingMessage(recordingBus(executed), delivered(REVOKED, revoked(init))),
    ).rejects.toBeInstanceOf(PermanentError);
    expect(executed).toEqual([]);
  });
});

describe(CLOSED, () => {
  it("becomes RevokeProfileLeases for the profile's leases on the device", async () => {
    const executed: unknown[] = [];
    const value = closed({
      deviceId: DEVICE,
      accountId: ACCOUNT,
      profileId: PROFILE,
      occurredAt: timestampFromDate(OCCURRED_AT),
      selfInitiated: true,
    });
    expect(await applyStreamingMessage(recordingBus(executed), delivered(CLOSED, value))).toBe(
      Outcome.APPLIED,
    );
    expect(executed).toEqual([
      new RevokeProfileLeases(DELIVERY, {
        accountId: ACCOUNT,
        deviceId: DEVICE,
        profileId: PROFILE,
        occurredAt: OCCURRED_AT,
      }),
    ]);
  });

  it('is dead-lettered at once without a profile, dispatching nothing', async () => {
    const executed: unknown[] = [];
    const value = closed({
      deviceId: DEVICE,
      accountId: ACCOUNT,
      occurredAt: timestampFromDate(OCCURRED_AT),
    });
    await expect(
      applyStreamingMessage(recordingBus(executed), delivered(CLOSED, value)),
    ).rejects.toBeInstanceOf(PermanentError);
    expect(executed).toEqual([]);
  });
});
