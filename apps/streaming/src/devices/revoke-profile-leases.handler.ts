import { Outcome, claimMessage } from '@arthome-platform/messaging';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import { IdentityErrorCode, type Clock } from '@arthome/core';

import { RevokeProfileLeases } from './revoke-profile-leases.command.js';
import { CLOCK } from '../clock.js';
import { PlaybackSessions } from '../playback/playback-sessions.js';
import { StreamingTransactions } from '../streaming-transactions.js';

/** Bounded by `occurred_at`, so a late or retried close never ends a lease opened after it. */
@CommandHandler(RevokeProfileLeases)
export class RevokeProfileLeasesHandler implements ICommandHandler<RevokeProfileLeases> {
  public constructor(
    private readonly transactions: StreamingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute({ delivery, fact }: RevokeProfileLeases): Promise<Outcome> {
    return this.transactions.run(async ({ manager }) => {
      if (!(await claimMessage(manager, delivery.messageId, delivery.topic))) {
        return Outcome.DUPLICATE;
      }
      await new PlaybackSessions(manager).revokeDevice(
        {
          accountId: fact.accountId,
          deviceId: fact.deviceId,
          profileId: fact.profileId,
          openedAtOrBefore: fact.occurredAt.toISOString(),
        },
        IdentityErrorCode.SIGNED_OUT_ELSEWHERE,
        this.clock.now(),
      );
      return Outcome.APPLIED;
    });
  }
}
