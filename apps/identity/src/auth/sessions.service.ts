import { createHmac } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { AccountStatus } from '@arthome/core';

import { Account } from './account.entity.js';
import { BETTER_AUTH } from './auth.tokens.js';
import type { Auth } from './better-auth.js';
import { invalidCredentials } from './refusals.js';
import type { Viewer } from './viewer.service.js';
import { DevicesService } from '../devices/devices.service.js';
import type { PresentedDevice } from '../devices/presented-device.schema.js';
import { defaultProfileOf, type ProfileSummary } from '../profiles/default-profile.js';
import type { ProfileKind } from '../profiles/profile-kind.js';

/** The statuses whose credential still opens a session: a deletion request is undone by signing in. */
const SIGNING_IN_STATUSES: readonly AccountStatus[] = [
  AccountStatus.ACTIVE,
  AccountStatus.DELETION_REQUESTED,
];

/** What the BFF needs to know about a session it was handed. */
export interface ResolvedSession {
  readonly accountId: string;
  /** The registered device (UUIDv7) the session is bound to: the internal token's `did`. */
  readonly deviceId: string;
  readonly deviceSessionId: string;
  readonly expiresAt: string;
  readonly profile: ProfileSummary;
}

/** A session in use, with what the viewer context shows of its account: one hop for the BFF. */
export interface ResolvedViewer extends ResolvedSession {
  readonly account: Viewer;
}

export interface EstablishedSession extends ResolvedSession {
  /** The signed token the surface carries, in a cookie or as a bearer. */
  readonly token: string;
}

/** What the idempotency record keeps of a session: its ids, never its token. */
export interface StoredSession extends ResolvedSession {
  readonly authSessionId: string;
}

/** A better-auth session just opened, not bound to a device yet: it resolves to nothing. */
export interface OpenedSession {
  readonly token: string;
  readonly authSessionId: string;
  readonly accountId: string;
  readonly expiresAt: string;
}

export interface Established {
  readonly session: EstablishedSession;
  readonly authSessionId: string;
  /** better-auth sessions whose binding this one replaced: deleted once it commits. */
  readonly replacedAuthSessionIds: readonly string[];
}

interface OpenBinding {
  readonly device_session_id: string;
  readonly device_id: string;
  readonly profile_id: string;
  readonly profile_name: string;
  readonly profile_kind: ProfileKind;
  readonly public_handle: string;
  readonly email_verified_at: Date | null;
}

/** One statement, so a resolve stays at today's two round trips (transport.md §5.9). */
const OPEN_BINDING_SQL = `
  SELECT ds.id AS device_session_id, ds.device_id,
         p.id AS profile_id, p.name AS profile_name, p.kind AS profile_kind,
         a.public_handle, a.email_verified_at
    FROM device_session ds
    JOIN device d ON d.id = ds.device_id
    JOIN profile p ON p.id = ds.profile_id
    JOIN account a ON a.id = ds.account_id
   WHERE ds.auth_session_id = $1
     AND ds.closed_at IS NULL
     AND d.revoked_at IS NULL
     AND a.id = $2
     AND a.status = ANY($3)`;

export function storedOf({ session, authSessionId }: Established): StoredSession {
  const { accountId, deviceId, deviceSessionId, expiresAt, profile } = session;
  return { accountId, authSessionId, deviceId, deviceSessionId, expiresAt, profile };
}

/** As better-auth hands a session token out: the raw token and its HMAC, which `bearer` checks. */
function signed(rawToken: string, secret: string): string {
  return `${rawToken}.${createHmac('sha256', secret).update(rawToken).digest('base64')}`;
}

function bearerHeaders(token: string): Headers {
  return new Headers({ authorization: `Bearer ${token}` });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The session store is better-auth's, read through its API: `getSession` slides a session in use
 *   forward once a day (`adr-auth.md` §6.1), and refuses an expired, revoked or unsigned token.
 *   Identity binds each session to a (device, profile) pair, and a session with no open binding
 *   resolves to nothing: sessions opened before the bindings existed sign in again.
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  public constructor(
    @Inject(BETTER_AUTH) private readonly auth: Auth,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly devices: DevicesService,
  ) {}

  /**
   * A session whose account may still sign in, bound to an unrevoked device, else null: an answer,
   *   not a 401, so a 401 from identity always means the BFF's own token was refused.
   */
  public async resolve(token: string): Promise<ResolvedViewer | null> {
    if (token === '') return null;
    const found = await this.find(token);
    if (found === null) return null;
    const [bound] = await this.dataSource.query<OpenBinding[]>(OPEN_BINDING_SQL, [
      found.session.id,
      found.user.id,
      SIGNING_IN_STATUSES,
    ]);
    if (bound === undefined) return null;
    return {
      accountId: found.user.id,
      deviceId: bound.device_id,
      deviceSessionId: bound.device_session_id,
      expiresAt: found.session.expiresAt.toISOString(),
      profile: { id: bound.profile_id, name: bound.profile_name, kind: bound.profile_kind },
      account: {
        publicHandle: bound.public_handle,
        emailVerified: bound.email_verified_at !== null,
      },
    };
  }

  /** A session just opened: its account is the caller's to check, in its own transaction. */
  public async opened(token: string): Promise<OpenedSession> {
    const found = await this.find(token);
    if (found === null) throw new Error('a session just opened could not be read back');
    return {
      token,
      authSessionId: found.session.id,
      accountId: found.user.id,
      expiresAt: found.session.expiresAt.toISOString(),
    };
  }

  /** Binds a session just opened to the device and the profile, in the caller's transaction. */
  public async establish(
    manager: EntityManager,
    opened: OpenedSession,
    deviceId: string,
    profile: ProfileSummary,
  ): Promise<Established> {
    const { deviceSessionId, replacedAuthSessionIds } = await this.devices.bind(manager, {
      authSessionId: opened.authSessionId,
      deviceId,
      accountId: opened.accountId,
      profileId: profile.id,
    });
    return {
      session: {
        token: opened.token,
        accountId: opened.accountId,
        deviceId,
        deviceSessionId,
        expiresAt: opened.expiresAt,
        profile,
      },
      authSessionId: opened.authSessionId,
      replacedAuthSessionIds,
    };
  }

  /** `binding` in its own transaction; a failure revokes the session, so none outlives its bind. */
  public async bindInTransaction<T extends Established>(
    opened: OpenedSession,
    binding: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    let established: T;
    try {
      established = await this.dataSource.transaction(binding);
    } catch (error) {
      await this.revokeQuietly(opened.token);
      throw error;
    }
    await this.forget(opened.accountId, established.replacedAuthSessionIds);
    return established;
  }

  /** Best effort: a replaced session resolves to nothing either way, its binding being closed. */
  public async forget(accountId: string, authSessionIds: readonly string[]): Promise<void> {
    if (authSessionIds.length === 0) return;
    try {
      const context = await this.auth.$context;
      const sessions = await context.internalAdapter.listSessions(accountId);
      await context.internalAdapter.deleteSessions(
        sessions.filter(({ id }) => authSessionIds.includes(id)).map(({ token }) => token),
      );
    } catch (error) {
      this.logger.warn(
        `replaced sessions of ${accountId} outlived their binding: ${messageOf(error)}`,
      );
    }
  }

  /**
   * Closes this session alone, and its binding: better-auth's `signOut` is not the right gesture on
   *   a shared screen. The binding goes first, so a failure in between still resolves to nothing.
   */
  public async revoke(token: string): Promise<void> {
    if (token === '') return;
    const found = await this.find(token);
    if (found === null) return;
    await this.devices.close(this.dataSource.manager, found.session.id);
    const context = await this.auth.$context;
    await context.internalAdapter.deleteSession(found.session.token);
  }

  /**
   * The session a replayed sign-up answers, known by its ids alone: the idempotency record keeps no
   *   token (security review M1). The same session while it resolves, else a fresh one, bound to the
   *   recorded device (a new one if it was revoked since) and the default profile, the one sign-up
   *   bound, for an account that may still sign in: the replay proved the password, since its
   *   fingerprint covers it. A record written before PI1 holds a session id as its device, which no
   *   device row matches, so its replay registers a new one.
   */
  public async reissue(
    stored: StoredSession,
    presented: PresentedDevice,
  ): Promise<EstablishedSession> {
    const context = await this.auth.$context;
    const sessions = await context.internalAdapter.listSessions(stored.accountId);
    const same = sessions.find(({ id }) => id === stored.authSessionId);
    if (same !== undefined) {
      const token = signed(same.token, context.secret);
      const resolved = await this.resolve(token);
      if (resolved !== null) {
        const { accountId, deviceId, deviceSessionId, expiresAt, profile } = resolved;
        return { token, accountId, deviceId, deviceSessionId, expiresAt, profile };
      }
    }
    const account = await this.dataSource.manager.findOneBy(Account, { id: stored.accountId });
    if (!this.isAllowedToSignIn(account)) throw invalidCredentials();
    const fresh = await context.internalAdapter.createSession(stored.accountId);
    const opened = await this.opened(signed(fresh.token, context.secret));
    const { session } = await this.bindInTransaction(opened, async (manager) => {
      const deviceId = (await this.devices.isRevoked(manager, stored.deviceId))
        ? (await this.devices.deviceFor(manager, { ...presented, token: null })).deviceId
        : stored.deviceId;
      return this.establish(
        manager,
        opened,
        deviceId,
        await defaultProfileOf(manager, stored.accountId),
      );
    });
    return session;
  }

  public isAllowedToSignIn(account: Account | null): boolean {
    return account !== null && SIGNING_IN_STATUSES.includes(account.status);
  }

  private async revokeQuietly(token: string): Promise<void> {
    try {
      await this.revoke(token);
    } catch (error) {
      this.logger.error(`a session outlived its failed binding: ${messageOf(error)}`);
    }
  }

  private find(token: string) {
    return this.auth.api.getSession({
      headers: bearerHeaders(token),
      query: { disableCookieCache: true },
    });
  }
}
