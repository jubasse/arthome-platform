import { Outcome, claimMessage } from '@arthome-platform/messaging';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import { IdentityErrorCode, type Clock } from '@arthome/core';

import { RevokeDeviceLeases } from './revoke-device-leases.command.js';
import { CLOCK } from '../clock.js';
import { PlaybackSessions } from '../playback/playback-sessions.js';
import { StreamingTransactions } from '../streaming-transactions.js';

/**
 * The message claimed in the transaction that revokes: a second delivery is a duplicate. Unbounded
 *   by `occurred_at`, unlike a profile's close: compared across two services' clocks, a bound could
 *   spare a lease opened just before the revocation.
 */
@CommandHandler(RevokeDeviceLeases)
export class RevokeDeviceLeasesHandler implements ICommandHandler<RevokeDeviceLeases> {
  public constructor(
    private readonly transactions: StreamingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute({ delivery, fact }: RevokeDeviceLeases): Promise<Outcome> {
    return this.transactions.run(async ({ manager }) => {
      if (!(await claimMessage(manager, delivery.messageId, delivery.topic))) {
        return Outcome.DUPLICATE;
      }
      await new PlaybackSessions(manager).revokeDevice(
        { accountId: fact.accountId, deviceId: fact.deviceId },
        IdentityErrorCode.SIGNED_OUT_ELSEWHERE,
        this.clock.now(),
      );
      return Outcome.APPLIED;
    });
  }
}
