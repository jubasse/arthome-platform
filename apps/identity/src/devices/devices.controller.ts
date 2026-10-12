import {
  AllowInProduction,
  CurrentPrincipal,
  accountOf,
  idempotentRequestOf,
  parseTraceparent,
  type MemorisedResponse,
  type Principal,
} from '@arthome-platform/http-edge';
import { Controller, Header, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';

import { ActorSurfaceParameter } from '@arthome/contracts/http';
import { DeviceIdSchema } from '@arthome/core/schema';

import { wireSurfaceOf, type DeviceAct } from './device-events.js';
import { DeviceRevocations } from './device-revocations.js';

/** The storefront BFF's device acts (PI1 §6 S5 and S6), for the account its token names. */
@AllowInProduction()
@Controller('v1')
export class DevicesController {
  public constructor(private readonly revocations: DeviceRevocations) {}

  @Post('devices/:deviceId/revoke')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public revoke(
    @CurrentPrincipal() principal: Principal,
    @Param('deviceId', { schema: DeviceIdSchema }) deviceId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers(ActorSurfaceParameter.name) surface?: string,
    @Headers('traceparent') traceparent?: string,
  ): Promise<MemorisedResponse<{ readonly revoked: true }>> {
    const act = actOf(principal, surface, traceparent);
    return this.revocations.revokeDevice(
      deviceId,
      act,
      idempotentRequestOf(
        'POST',
        `/v1/devices/${deviceId}/revoke`,
        {},
        200,
        idempotencyKey,
        act.accountId,
      ),
    );
  }

  @Post('device-sessions/:sessionId/close')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public close(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId', { schema: z.uuid() }) sessionId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers(ActorSurfaceParameter.name) surface?: string,
    @Headers('traceparent') traceparent?: string,
  ): Promise<MemorisedResponse<{ readonly closed: true }>> {
    const act = actOf(principal, surface, traceparent);
    return this.revocations.closeDeviceSession(
      sessionId,
      act,
      idempotentRequestOf(
        'POST',
        `/v1/device-sessions/${sessionId}/close`,
        {},
        200,
        idempotencyKey,
        act.accountId,
      ),
    );
  }
}

function actOf(
  principal: Principal,
  surface: string | undefined,
  traceparent: string | undefined,
): DeviceAct {
  return {
    accountId: accountOf(principal),
    fromDeviceId: principal.deviceId,
    surface: wireSurfaceOf(surface),
    traceparent: parseTraceparent(traceparent)?.traceparent ?? null,
  };
}
