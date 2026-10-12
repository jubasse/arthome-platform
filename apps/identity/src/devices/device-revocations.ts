import {
  runIdempotently,
  type IdempotentRequest,
  type MemorisedResponse,
} from '@arthome-platform/http-edge';
import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { Clock } from '@arthome/core';

import type { ClosedBinding, DeviceAct } from './device-events.js';
import { DevicesService } from './devices.service.js';
import { SessionsService } from '../auth/sessions.service.js';
import { CLOCK } from '../clock.js';

/**
 * A viewer disconnecting a device or signing a profile out of one (`data-model.md` §1.3): the rows
 *   and their events in one transaction under the request's key, then the better-auth sessions of
 *   the closed bindings deleted. A replay closes nothing, so it deletes nothing.
 */
@Injectable()
export class DeviceRevocations {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly devices: DevicesService,
    private readonly sessions: SessionsService,
  ) {}

  public async revokeDevice(
    deviceId: string,
    act: DeviceAct,
    request: IdempotentRequest,
  ): Promise<MemorisedResponse<{ readonly revoked: true }>> {
    let closed: readonly ClosedBinding[] = [];
    const memorised = await this.dataSource.transaction((manager) =>
      runIdempotently(manager, request, this.clock, async () => {
        closed = await this.devices.revoke(manager, deviceId, act);
        return { revoked: true as const };
      }),
    );
    await this.sessions.forgetClosed(closed);
    return memorised;
  }

  /** `closed: true` also when it was closed already: the act's outcome holds either way. */
  public async closeDeviceSession(
    deviceSessionId: string,
    act: DeviceAct,
    request: IdempotentRequest,
  ): Promise<MemorisedResponse<{ readonly closed: true }>> {
    let closed: ClosedBinding | null = null;
    const memorised = await this.dataSource.transaction((manager) =>
      runIdempotently(manager, request, this.clock, async () => {
        closed = await this.devices.closeSession(manager, deviceSessionId, act);
        return { closed: true as const };
      }),
    );
    if (closed !== null) await this.sessions.forgetClosed([closed]);
    return memorised;
  }
}
