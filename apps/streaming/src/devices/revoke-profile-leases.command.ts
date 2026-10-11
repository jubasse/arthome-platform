import type { Outcome } from '@arthome-platform/messaging';
import { Command } from '@nestjs/cqrs';

import type { Delivery } from '../delivery.js';

/**
 * `identity.device_session.closed.v1`: one profile signed out of one device. Only the leases it
 *   opened there before the close go; a later sign-in keeps its new lease.
 */
export interface DeviceSessionClosedFact {
  readonly accountId: string;
  readonly deviceId: string;
  readonly profileId: string;
  readonly occurredAt: Date;
}

export class RevokeProfileLeases extends Command<Outcome> {
  public constructor(
    public readonly delivery: Delivery,
    public readonly fact: DeviceSessionClosedFact,
  ) {
    super();
  }
}
