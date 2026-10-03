import { createHmac } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AccountStatus } from '@arthome/core';

import { Account } from './account.entity.js';
import { BETTER_AUTH } from './auth.tokens.js';
import type { Auth } from './better-auth.js';
import { invalidCredentials } from './refusals.js';

/** The statuses whose credential still opens a session: a deletion request is undone by signing in. */
const SIGNING_IN_STATUSES: readonly AccountStatus[] = [
  AccountStatus.ACTIVE,
  AccountStatus.DELETION_REQUESTED,
];

/** What the BFF needs to know about a session it was handed. */
export interface ResolvedSession {
  readonly accountId: string;
  /**
   * The session's own id, standing for the device until a device registers (auth slice C): one
   * session per browser or application instance.
   */
  readonly deviceId: string;
  readonly expiresAt: string;
}

export interface EstablishedSession extends ResolvedSession {
  /** The signed token the surface carries, in a cookie or as a bearer. */
  readonly token: string;
}

function describe(found: {
  readonly user: { readonly id: string };
  readonly session: { readonly id: string; readonly expiresAt: Date };
}): ResolvedSession {
  return {
    accountId: found.user.id,
    deviceId: found.session.id,
    expiresAt: found.session.expiresAt.toISOString(),
  };
}

/** As better-auth hands a session token out: the raw token and its HMAC, which `bearer` checks. */
function signed(rawToken: string, secret: string): string {
  return `${rawToken}.${createHmac('sha256', secret).update(rawToken).digest('base64')}`;
}

/** What a session is without the token that opens it: what may be stored. */
export function withoutToken({
  accountId,
  deviceId,
  expiresAt,
}: EstablishedSession): ResolvedSession {
  return { accountId, deviceId, expiresAt };
}

function bearerHeaders(token: string): Headers {
  return new Headers({ authorization: `Bearer ${token}` });
}

/**
 * The session store is better-auth's, read through its API: `getSession` slides a session in use
 *   forward once a day (`adr-auth.md` §6.1), and refuses an expired, revoked or unsigned token.
 */
@Injectable()
export class SessionsService {
  public constructor(
    @Inject(BETTER_AUTH) private readonly auth: Auth,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * A session whose account may still sign in, else null: an answer, not a 401, so a 401 from
   *   identity always means the BFF's own token was refused.
   */
  public async resolve(token: string): Promise<ResolvedSession | null> {
    if (token === '') return null;
    const found = await this.find(token);
    if (found === null) return null;
    const account = await this.dataSource.manager.findOneBy(Account, { id: found.user.id });
    return this.isAllowedToSignIn(account) ? describe(found) : null;
  }

  /** A session just opened: its account is the caller's to check, in its own transaction. */
  public async established(token: string): Promise<EstablishedSession> {
    return { ...(await this.sessionOf(token)), token };
  }

  /** Closes this session alone: better-auth's `signOut` is not the right gesture on a shared screen. */
  public async revoke(token: string): Promise<void> {
    if (token === '') return;
    const found = await this.find(token);
    if (found === null) return;
    const context = await this.auth.$context;
    await context.internalAdapter.deleteSession(found.session.token);
  }

  /**
   * The signed token of a session known by its id alone, as a replayed sign-up needs it: the
   *   idempotency record keeps no token (security review M1). The same session while it lives, else
   *   a fresh one for an account that may still sign in: the replay proved the password, since its
   *   fingerprint covers it.
   */
  public async reissue(stored: ResolvedSession): Promise<EstablishedSession> {
    const context = await this.auth.$context;
    const sessions = await context.internalAdapter.listSessions(stored.accountId);
    const same = sessions.find(({ id }) => id === stored.deviceId);
    if (same !== undefined) {
      const token = signed(same.token, context.secret);
      if ((await this.find(token)) !== null) return this.established(token);
    }
    const account = await this.dataSource.manager.findOneBy(Account, { id: stored.accountId });
    if (!this.isAllowedToSignIn(account)) throw invalidCredentials();
    const fresh = await context.internalAdapter.createSession(stored.accountId);
    return this.established(signed(fresh.token, context.secret));
  }

  public isAllowedToSignIn(account: Account | null): boolean {
    return account !== null && SIGNING_IN_STATUSES.includes(account.status);
  }

  private async sessionOf(token: string): Promise<ResolvedSession> {
    const found = await this.find(token);
    if (found === null) throw new Error('a session just opened could not be read back');
    return describe(found);
  }

  private find(token: string) {
    return this.auth.api.getSession({
      headers: bearerHeaders(token),
      query: { disableCookieCache: true },
    });
  }
}
