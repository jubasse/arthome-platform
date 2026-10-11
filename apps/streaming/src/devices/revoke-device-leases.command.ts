import type { Outcome } from '@arthome-platform/messaging';
import { Command } from '@nestjs/cqrs';

import type { Delivery } from '../delivery.js';

/** `identity.device.revoked.v1`: the device left the account, every lease it holds goes. */
export interface DeviceRevokedFact {
  readonly accountId: string;
  readonly deviceId: string;
  readonly occurredAt: Date;
}

export class RevokeDeviceLeases extends Command<Outcome> {
  public constructor(
    public readonly delivery: Delivery,
    public readonly fact: DeviceRevokedFact,
  ) {
    super();
  }
}
