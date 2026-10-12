import {
  DeviceKind as WireDeviceKind,
  DeviceRevokedSchema,
  DeviceSessionClosedSchema,
  Surface as WireSurface,
} from '@arthome-platform/events';
import type { OutboxEvent } from '@arthome-platform/messaging';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';

import { DEVICE_KINDS, DeviceKind, Surface } from '@arthome/core';

import {
  DEVICE_REVOKED,
  DEVICE_SESSION_CLOSED,
  WIRE_DEVICE_KIND,
  WIRE_SURFACE,
  recordDeviceRevoked,
  recordDeviceSessionClosed,
  wireSurfaceOf,
  type ClosedBinding,
  type DeviceAct,
} from './device-events.js';

const OCCURRED_AT = new Date('2026-10-12T12:00:00.000Z');
const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const CALLER = '01a0f700-0000-7000-8000-000000000001';
const DEVICE = '01a0f700-0000-7000-8000-000000000002';
const PROFILE = '01a0f700-0000-7000-8000-000000000003';

const ACT: DeviceAct = {
  accountId: CALLER,
  fromDeviceId: DEVICE,
  surface: WireSurface.STOREFRONT_TV,
  traceparent: TRACEPARENT,
};

const BINDING: ClosedBinding = {
  deviceSessionId: '6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
  deviceId: DEVICE,
  accountId: CALLER,
  profileId: PROFILE,
  authSessionId: 'auth-session',
};

/** The row `writeOutboxEvent` inserts, caught on a manager that only inserts. */
function capturing(): { manager: EntityManager; rows: () => Partial<OutboxEvent>[] } {
  const insert = vi.fn();
  return {
    manager: { insert } as unknown as EntityManager,
    rows: () => insert.mock.calls.map(([, row]) => row as Partial<OutboxEvent>),
  };
}

describe('the wire maps', () => {
  it('give every device kind its own wire member', () => {
    const wired = DEVICE_KINDS.map((kind) => WIRE_DEVICE_KIND[kind]);
    expect(wired).not.toContain(WireDeviceKind.UNSPECIFIED);
    expect(new Set(wired).size).toBe(DEVICE_KINDS.length);
  });

  it('give every storefront surface its own wire member', () => {
    const storefront = [Surface.STOREFRONT_WEB, Surface.STOREFRONT_MOBILE, Surface.STOREFRONT_TV];
    const wired = storefront.map((surface) => WIRE_SURFACE[surface]);
    expect(wired).toEqual([
      WireSurface.STOREFRONT_WEB,
      WireSurface.STOREFRONT_MOBILE,
      WireSurface.STOREFRONT_TV,
    ]);
  });

  it('read a relayed surface, and an unknown or absent one as unspecified', () => {
    expect(wireSurfaceOf(Surface.STOREFRONT_MOBILE)).toBe(WireSurface.STOREFRONT_MOBILE);
    expect(wireSurfaceOf('smart_fridge')).toBe(WireSurface.UNSPECIFIED);
    expect(wireSurfaceOf(undefined)).toBe(WireSurface.UNSPECIFIED);
  });
});

describe('the device events', () => {
  it('write a revocation keyed by the device, which reads back whole', async () => {
    const { manager, rows } = capturing();
    await recordDeviceRevoked(
      manager,
      { deviceId: DEVICE, accountId: CALLER, kind: DeviceKind.STICK },
      ACT,
      OCCURRED_AT,
    );

    const [row] = rows();
    expect(row).toMatchObject({
      aggregatetype: 'identity.device',
      aggregateid: DEVICE,
      type: DEVICE_REVOKED,
      tracecontext: TRACEPARENT,
      actor_id: CALLER,
      created_at: OCCURRED_AT,
    });
    const event = fromBinary(DeviceRevokedSchema, row?.payload as Uint8Array);
    expect(event).toMatchObject({
      deviceId: DEVICE,
      accountId: CALLER,
      kind: WireDeviceKind.STICK,
      revokedBy: { accountId: CALLER, surface: WireSurface.STOREFRONT_TV },
    });
    expect(timestampDate(event.occurredAt!)).toEqual(OCCURRED_AT);
  });

  it('write a close as self-initiated from the same device only', async () => {
    const { manager, rows } = capturing();
    await recordDeviceSessionClosed(manager, BINDING, ACT, OCCURRED_AT);
    await recordDeviceSessionClosed(
      manager,
      BINDING,
      { ...ACT, fromDeviceId: '01a0f700-0000-7000-8000-000000000009' },
      OCCURRED_AT,
    );

    const [fromItself, fromElsewhere] = rows().map((row) => {
      expect(row).toMatchObject({
        aggregatetype: 'identity.device',
        aggregateid: DEVICE,
        type: DEVICE_SESSION_CLOSED,
      });
      return fromBinary(DeviceSessionClosedSchema, row.payload as Uint8Array);
    });
    expect(fromItself).toMatchObject({
      deviceId: DEVICE,
      accountId: CALLER,
      profileId: PROFILE,
      selfInitiated: true,
      closedBy: { accountId: CALLER, surface: WireSurface.STOREFRONT_TV },
    });
    expect(timestampDate(fromItself!.occurredAt!)).toEqual(OCCURRED_AT);
    expect(fromElsewhere?.selfInitiated).toBe(false);
  });
});
