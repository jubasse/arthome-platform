// Aliased because `@arthome-platform/events` is a flat barrel: a wire enum and core's
// vocabulary share each name, and they are a number and a string.
import {
  ActorSchema,
  DeviceKind as WireDeviceKind,
  DeviceRevokedSchema,
  DeviceSessionClosedSchema,
  Surface as WireSurface,
} from '@arthome-platform/events';
import { writeOutboxEvent } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EntityManager } from 'typeorm';

import { ActorSurfaceParameter } from '@arthome/contracts/http';
import { DeviceKind, Surface } from '@arthome/core';

/** The topic `arthome.identity.device` (`events.md` §3), keyed by the device. */
const DEVICE_AGGREGATE = 'identity.device';

export const DEVICE_REVOKED = 'identity.device.revoked.v1';
export const DEVICE_SESSION_CLOSED = 'identity.device_session.closed.v1';

/**
 * The domain's members → the wire's numbers. `satisfies` points at the domain: a new member in
 *   core fails this build, and the proto's `UNSPECIFIED = 0` rightly has no domain member.
 */
export const WIRE_DEVICE_KIND = {
  [DeviceKind.TV]: WireDeviceKind.TV,
  [DeviceKind.MOBILE]: WireDeviceKind.MOBILE,
  [DeviceKind.TABLET]: WireDeviceKind.TABLET,
  [DeviceKind.DESKTOP]: WireDeviceKind.DESKTOP,
  [DeviceKind.STICK]: WireDeviceKind.STICK,
  [DeviceKind.CONSOLE]: WireDeviceKind.CONSOLE,
  [DeviceKind.BOX]: WireDeviceKind.BOX,
} satisfies Record<DeviceKind, WireDeviceKind>;

export const WIRE_SURFACE = {
  [Surface.STOREFRONT_WEB]: WireSurface.STOREFRONT_WEB,
  [Surface.STOREFRONT_MOBILE]: WireSurface.STOREFRONT_MOBILE,
  [Surface.STOREFRONT_TV]: WireSurface.STOREFRONT_TV,
  [Surface.STUDIO_WEB]: WireSurface.STUDIO_WEB,
  [Surface.STUDIO_MOBILE]: WireSurface.STUDIO_MOBILE,
  [Surface.SYSTEM]: WireSurface.SYSTEM,
} satisfies Record<Surface, WireSurface>;

/** Who acts on a device, from where, under which trace: the event's actor and its row's. */
export interface DeviceAct {
  /** The verified caller: the internal token's `sub`, or the session's own account on sign-out. */
  readonly accountId: string;
  /** The token's `did`: the device the act comes from, when the token names one. */
  readonly fromDeviceId: string | null;
  readonly surface: WireSurface;
  readonly traceparent: string | null;
}

/** The relayed `x-arthome-actor-surface`; one the vocabulary does not know is no surface. */
export function wireSurfaceOf(relayed: string | undefined): WireSurface {
  const parsed = ActorSurfaceParameter.schema.safeParse(relayed);
  return parsed.success ? WIRE_SURFACE[parsed.data] : WireSurface.UNSPECIFIED;
}

export interface ClosedBinding {
  readonly deviceSessionId: string;
  readonly deviceId: string;
  readonly accountId: string;
  readonly profileId: string;
  readonly authSessionId: string;
}

function actorOf(act: DeviceAct) {
  return create(ActorSchema, { accountId: act.accountId, surface: act.surface });
}

/** Once per device, by the last account holding it: streaming keys on (account, device). */
export async function recordDeviceRevoked(
  manager: EntityManager,
  revoked: { readonly deviceId: string; readonly accountId: string; readonly kind: DeviceKind },
  act: DeviceAct,
  occurredAt: Date,
): Promise<void> {
  const event = create(DeviceRevokedSchema, {
    deviceId: revoked.deviceId,
    accountId: revoked.accountId,
    kind: WIRE_DEVICE_KIND[revoked.kind],
    occurredAt: timestampFromDate(occurredAt),
    revokedBy: actorOf(act),
  });
  await writeOutboxEvent(
    manager,
    {
      aggregateType: DEVICE_AGGREGATE,
      aggregateId: revoked.deviceId,
      type: DEVICE_REVOKED,
      payload: toBinary(DeviceRevokedSchema, event),
      traceparent: act.traceparent,
      actorId: act.accountId,
    },
    occurredAt,
  );
}

/** `self_initiated` when the act comes from the device itself (`events.proto`). */
export async function recordDeviceSessionClosed(
  manager: EntityManager,
  closed: ClosedBinding,
  act: DeviceAct,
  occurredAt: Date,
): Promise<void> {
  const event = create(DeviceSessionClosedSchema, {
    deviceId: closed.deviceId,
    accountId: closed.accountId,
    profileId: closed.profileId,
    occurredAt: timestampFromDate(occurredAt),
    selfInitiated: act.fromDeviceId === closed.deviceId,
    closedBy: actorOf(act),
  });
  await writeOutboxEvent(
    manager,
    {
      aggregateType: DEVICE_AGGREGATE,
      aggregateId: closed.deviceId,
      type: DEVICE_SESSION_CLOSED,
      payload: toBinary(DeviceSessionClosedSchema, event),
      traceparent: act.traceparent,
      actorId: act.accountId,
    },
    occurredAt,
  );
}
