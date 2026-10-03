import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AccountStatus } from '@arthome/core';

import { Account } from './account.entity.js';
import { BETTER_AUTH } from './auth.tokens.js';
import type { Auth } from './better-auth.js';

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
    const found = await this.find(token);
    if (found === null) return;
    const context = await this.auth.$context;
    await context.internalAdapter.deleteSession(found.session.token);
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
