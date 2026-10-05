import { createHash, randomBytes } from 'node:crypto';

import { EmailVerificationRequestedSchema } from '@arthome-platform/events';
import {
  runIdempotently,
  unauthenticated,
  type IdempotentRequest,
  type MemorisedResponse,
} from '@arthome-platform/http-edge';
import { writeOutboxEvent } from '@arthome-platform/messaging';
import { updateReturning } from '@arthome-platform/transactions';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { EMAIL_VERIFICATION_LINK_LIFETIME_HOURS, type Clock } from '@arthome/core';

import { Account } from './account.entity.js';
import { EmailVerification } from './email-verification.entity.js';
import { verificationLinkInvalid } from './refusals.js';
import { CLOCK } from '../clock.js';

/** 256 bits: a token is guessed by nobody, and its hash is all identity keeps. */
const TOKEN_BYTES = 32;

export interface VerificationRecipient {
  readonly accountId: string;
  readonly email: string;
  readonly locale: string;
}

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Email verification (`adr-auth.md` §6.7, D-100): a link at sign-up and on request, spent by its
 *   first use, expired after a day, and good only for the address it was sent to.
 */
@Injectable()
export class EmailVerificationsService {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * In the caller's transaction, with the outbox row that carries the token to `notifications`.
   *   The earlier links of the account are spent: the newest is the one the person will open.
   */
  public async issue(
    manager: EntityManager,
    recipient: VerificationRecipient,
    traceparent: string | null,
  ): Promise<void> {
    const issuedAt = new Date(this.clock.nowMs());
    const expiresAt = new Date(
      this.clock.nowMs() + EMAIL_VERIFICATION_LINK_LIFETIME_HOURS * 60 * 60 * 1000,
    );
    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    await manager.query(
      'UPDATE email_verification SET used_at = $2 WHERE account_id = $1 AND used_at IS NULL',
      [recipient.accountId, issuedAt],
    );
    await manager.insert(EmailVerification, {
      token_hash: hashOf(token),
      account_id: recipient.accountId,
      email: recipient.email,
      expires_at: expiresAt,
      used_at: null,
    });

    const event = create(EmailVerificationRequestedSchema, {
      accountId: recipient.accountId,
      occurredAt: timestampFromDate(issuedAt),
      email: recipient.email,
      locale: recipient.locale,
      token,
      expiresAt: timestampFromDate(expiresAt),
    });
    await writeOutboxEvent(
      manager,
      {
        // Its own topic, which `notifications` alone reads (events.md §3). The token is never
        //   logged, here or by the connector.
        aggregateType: 'identity.email_verification',
        aggregateId: recipient.accountId,
        type: 'identity.email_verification.requested.v1',
        payload: toBinary(EmailVerificationRequestedSchema, event),
        traceparent,
        actorId: recipient.accountId,
      },
      issuedAt,
    );
  }

  /**
   * `queued: true` once the link is in the outbox for `notifications`, which owns the sending;
   *   `queued: false` when the address is verified already, which is not a refusal.
   */
  public resend(
    accountId: string,
    request: IdempotentRequest,
    traceparent: string | null,
  ): Promise<MemorisedResponse<{ readonly queued: boolean }>> {
    return this.dataSource.transaction((manager) =>
      runIdempotently(manager, request, this.clock, async () => {
        const account = await manager.findOne(Account, {
          where: { id: accountId },
          lock: { mode: 'pessimistic_write' },
        });
        if (account === null) throw unauthenticated();
        if (account.email_verified_at !== null) return { queued: false };
        await this.issue(
          manager,
          { accountId, email: account.email, locale: account.locale },
          traceparent,
        );
        return { queued: true };
      }),
    );
  }

  /**
   * Spends the token and verifies the address, under the claim of the request's key: a replay
   *   answers the first `200`, another key the `410`. The account's row is locked before the link's,
   *   the order `resend` takes too, so the two never wait on each other.
   */
  public confirm(
    token: string,
    request: IdempotentRequest,
  ): Promise<MemorisedResponse<{ readonly verified: true }>> {
    return this.dataSource.transaction((manager) =>
      runIdempotently(manager, request, this.clock, async () => {
        const now = new Date(this.clock.nowMs());
        const tokenHash = hashOf(token);
        const link = await manager.findOneBy(EmailVerification, { token_hash: tokenHash });
        if (link === null) throw verificationLinkInvalid();
        await manager.findOne(Account, {
          where: { id: link.account_id },
          lock: { mode: 'pessimistic_write' },
        });

        const [spent] = await updateReturning<{ readonly account_id: string }>(
          manager,
          `UPDATE email_verification v
              SET used_at = $2
             FROM account a
            WHERE v.token_hash = $1
              AND v.used_at IS NULL
              AND v.expires_at > $2
              AND a.id = v.account_id
              AND a.email = v.email
        RETURNING v.account_id`,
          [tokenHash, now],
        );
        if (spent === undefined) throw verificationLinkInvalid();
        await manager.query(
          'UPDATE account SET email_verified_at = $2 WHERE id = $1 AND email_verified_at IS NULL',
          [spent.account_id, now],
        );
        return { verified: true as const };
      }),
    );
  }
}
