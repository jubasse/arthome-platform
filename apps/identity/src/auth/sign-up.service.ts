import { randomBytes } from 'node:crypto';

import { AccountRegisteredSchema } from '@arthome-platform/events';
import {
  MemorisedResponse,
  runIdempotently,
  type IdempotentRequest,
} from '@arthome-platform/http-edge';
import { writeOutboxEvent } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { isAPIError } from 'better-auth/api';
import { DataSource, type EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import {
  AccountStatus,
  GENERATED_HANDLE_RANDOM_LENGTH,
  generatedPublicHandle,
  type Clock,
} from '@arthome/core';

import { BETTER_AUTH } from './auth.tokens.js';
import { withPresetUserId, type Auth } from './better-auth.js';
import { EmailVerificationsService } from './email-verifications.service.js';
import { emailTaken } from './refusals.js';
import {
  SessionsService,
  withoutToken,
  type EstablishedSession,
  type ResolvedSession,
} from './sessions.service.js';
import type { SignUpBody } from './sign-up.schema.js';
import { CLOCK } from '../clock.js';

/** 2^40 handles: a fifth collision in a row is a broken generator, not bad luck. */
const HANDLE_ATTEMPTS = 5;

export interface SignedUp {
  readonly session: EstablishedSession;
  readonly account: { readonly publicHandle: string; readonly emailVerified: boolean };
}

/** What the idempotency record keeps of a sign-up: the session by its id, never its token. */
interface SignUpRecord {
  readonly session: ResolvedSession;
  readonly account: SignedUp['account'];
}

/**
 * Two stores, so the order is the design. Identity's transaction writes the account, its two events
 *   and the idempotency claim, then better-auth writes the credential with the same id on its own
 *   connection, then the transaction commits: a refused credential (a taken address) rolls everything
 *   back, and a commit that fails after the credential exists removes the credential. Only a crash
 *   between the two commits leaves a credential with no account, which the next sign-up of that
 *   address finds and replaces (`replaceOrphanCredential`). The idempotency record keeps the
 *   session by its id, never its token; a replay re-signs it (`SessionsService.reissue`).
 */
@Injectable()
export class SignUpService {
  private readonly logger = new Logger(SignUpService.name);

  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(BETTER_AUTH) private readonly auth: Auth,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly verifications: EmailVerificationsService,
    private readonly sessions: SessionsService,
  ) {}

  public async signUp(
    body: SignUpBody,
    request: IdempotentRequest,
    traceparent: string | null,
  ): Promise<MemorisedResponse<SignedUp>> {
    let credentialOf: string | null = null;
    let issued: EstablishedSession | null = null;
    try {
      const memorised = await this.dataSource.transaction((manager) =>
        runIdempotently(manager, request, this.clock, async (): Promise<SignUpRecord> => {
          const accountId = uuidv7();
          const publicHandle = await this.insertAccount(manager, accountId, body);
          await this.recordRegistration(manager, accountId, body, traceparent);
          await this.verifications.issue(
            manager,
            { accountId, email: body.email, locale: body.locale },
            traceparent,
          );
          const token = await this.createCredential(accountId, body);
          credentialOf = accountId;
          issued = await this.sessions.established(token);
          return {
            session: withoutToken(issued),
            account: { publicHandle, emailVerified: false },
          };
        }),
      );
      const { envelope } = memorised;
      const session = issued ?? (await this.sessions.reissue(envelope.data.session));
      return new MemorisedResponse(
        { ...envelope, data: { ...envelope.data, session } },
        memorised.replayed,
      );
    } catch (error) {
      if (credentialOf !== null) await this.removeCredential(credentialOf);
      throw error;
    }
  }

  /** `ON CONFLICT DO NOTHING`, so a taken address or handle never aborts the transaction (765134a). */
  private async insertAccount(
    manager: EntityManager,
    accountId: string,
    body: SignUpBody,
  ): Promise<string> {
    const acceptedAt = new Date(this.clock.nowMs());
    for (let attempt = 0; attempt < HANDLE_ATTEMPTS; attempt += 1) {
      const publicHandle = generatedPublicHandle(randomBytes(GENERATED_HANDLE_RANDOM_LENGTH));
      const inserted = await manager.query<unknown[]>(
        `INSERT INTO account
           (id, public_handle, email, locale, country, status, terms_version, terms_accepted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          accountId,
          publicHandle,
          body.email,
          body.locale,
          body.country,
          AccountStatus.ACTIVE,
          body.acceptedTermsVersion,
          acceptedAt,
        ],
      );
      if (inserted.length > 0) return publicHandle;
      const taken = await manager.query<unknown[]>('SELECT 1 FROM account WHERE email = $1', [
        body.email,
      ]);
      if (taken.length > 0) throw emailTaken();
    }
    throw new Error(`no free public handle after ${HANDLE_ATTEMPTS} attempts`);
  }

  private async recordRegistration(
    manager: EntityManager,
    accountId: string,
    body: SignUpBody,
    traceparent: string | null,
  ): Promise<void> {
    const occurredAt = new Date(this.clock.nowMs());
    const event = create(AccountRegisteredSchema, {
      accountId,
      occurredAt: timestampFromDate(occurredAt),
      locale: body.locale,
      country: body.country,
    });
    await writeOutboxEvent(
      manager,
      {
        aggregateType: 'identity.account',
        aggregateId: accountId,
        type: 'identity.account.registered.v1',
        payload: toBinary(AccountRegisteredSchema, event),
        traceparent,
        // The person is the actor, and has an id from this transaction on.
        actorId: accountId,
      },
      occurredAt,
    );
  }

  /** The signed session token better-auth hands out, the credential stored under `accountId`. */
  private async createCredential(accountId: string, body: SignUpBody): Promise<string> {
    const signUp = () =>
      withPresetUserId(accountId, () =>
        this.auth.api.signUpEmail({
          body: { email: body.email, password: body.password, name: body.displayName ?? '' },
          returnHeaders: true,
        }),
      );

    let created;
    try {
      created = await signUp();
    } catch (error) {
      if (!isAPIError(error) || error.body?.code !== 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') {
        throw error;
      }
      // The account row was free, so this credential belongs to no account.
      await this.replaceOrphanCredential(body.email);
      created = await signUp();
    }

    const token = created.headers.get('set-auth-token');
    if (created.response.user.id !== accountId || token === null) {
      throw new Error('better-auth did not create the credential under the account id');
    }
    return token;
  }

  private async replaceOrphanCredential(email: string): Promise<void> {
    const context = await this.auth.$context;
    const orphan = await context.internalAdapter.findUserByEmail(email);
    if (orphan === null) return;
    this.logger.warn(`a credential with no account was replaced: ${orphan.user.id}`);
    await context.internalAdapter.deleteUser(orphan.user.id);
  }

  private async removeCredential(accountId: string): Promise<void> {
    try {
      const context = await this.auth.$context;
      await context.internalAdapter.deleteUser(accountId);
    } catch (error) {
      this.logger.error(`the credential of ${accountId} outlived its failed sign-up`, error);
    }
  }
}
