import { updateReturning } from '@arthome-platform/transactions';
import type { EntityManager } from 'typeorm';

import type {
  DrmSystem,
  EdgeRenewalMode,
  PlaybackProtocol,
  QualityCap,
} from '@arthome/contracts/streaming';
import {
  PlaybackSessionState,
  toEpochMs,
  type IdentityErrorCode,
  type Instant,
  type StorefrontSurface,
  type WatchDenialReason,
} from '@arthome/core';

import type { ScreenLease } from './screen-allowance.js';
import type { TicketScope } from './token-claims.js';

export type RevokeReason = WatchDenialReason | typeof IdentityErrorCode.SIGNED_OUT_ELSEWHERE;

export interface PlaybackSession extends ScreenLease {
  readonly accountId: string;
  readonly profileId: string;
  readonly dateId: string;
  readonly state: PlaybackSessionState;
  readonly revokeReason: RevokeReason | null;
  readonly scope: TicketScope;
  readonly sessionScope: string;
  readonly protocol: PlaybackProtocol;
  readonly drmSystem: DrmSystem | null;
  readonly qualityCap: QualityCap;
  readonly edgeRenewalMode: EdgeRenewalMode;
  readonly surface: StorefrontSurface;
  readonly tokenId: string;
  readonly tokenExpiresAt: Instant;
}

/** What an opening or a renewal writes of the token it issued and the lease it extended. */
export interface Issue {
  readonly scope: TicketScope;
  readonly tokenId: string;
  readonly tokenExpiresAt: Instant;
  readonly leaseExpiresAt: Instant;
  readonly at: Instant;
}

/** A resumption takes the device's lease with the opener's profile (D-103) and today's format. */
export interface Reopening extends Issue {
  readonly profileId: string;
  readonly protocol: PlaybackProtocol;
  readonly drmSystem: DrmSystem | null;
  readonly qualityCap: QualityCap;
  readonly edgeRenewalMode: EdgeRenewalMode;
  readonly surface: StorefrontSurface;
}

export interface Opening extends Reopening {
  readonly id: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly dateId: string;
  readonly sessionScope: string;
}

interface SessionRow {
  readonly id: string;
  readonly account_id: string;
  readonly profile_id: string;
  readonly device_id: string;
  readonly date_id: string;
  readonly state: PlaybackSessionState;
  readonly revoke_reason: RevokeReason | null;
  readonly scope: TicketScope;
  readonly session_scope: string;
  readonly protocol: PlaybackProtocol;
  readonly drm_system: DrmSystem | null;
  readonly quality_cap: QualityCap;
  readonly edge_renewal_mode: EdgeRenewalMode;
  readonly surface: StorefrontSurface;
  readonly token_id: string;
  readonly token_expires_at: Date;
  readonly lease_expires_at: Date;
  readonly opened_at: Date;
  readonly last_renewed_at: Date;
}

const ACTIVE = `'${PlaybackSessionState.ACTIVE}'`;

function sessionOf(row: SessionRow): PlaybackSession {
  return {
    id: row.id,
    accountId: row.account_id,
    profileId: row.profile_id,
    deviceId: row.device_id,
    dateId: row.date_id,
    state: row.state,
    revokeReason: row.revoke_reason,
    scope: row.scope,
    sessionScope: row.session_scope,
    protocol: row.protocol,
    drmSystem: row.drm_system,
    qualityCap: row.quality_cap,
    edgeRenewalMode: row.edge_renewal_mode,
    surface: row.surface,
    tokenId: row.token_id,
    tokenExpiresAt: row.token_expires_at.toISOString(),
    leaseExpiresAt: row.lease_expires_at.toISOString(),
    openedAt: row.opened_at.toISOString(),
    lastRenewedAt: row.last_renewed_at.toISOString(),
  };
}

export interface ActiveScreen {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly isCurrentDevice: boolean;
  /** The opening's surface, and no city, until identity's device names reach streaming. */
  readonly deviceLabel: string;
  readonly city: null;
  readonly openedAt: Instant;
}

/** What a refusal lists of the screens, in the order they opened: never a token, a scope or a cookie. */
export function activeScreensOf(
  screens: readonly PlaybackSession[],
  deviceId: string,
): ActiveScreen[] {
  const byOpening = [...screens].sort(
    (left, right) => toEpochMs(left.openedAt) - toEpochMs(right.openedAt),
  );
  return byOpening.map((screen) => ({
    sessionId: screen.id,
    deviceId: screen.deviceId,
    isCurrentDevice: screen.deviceId === deviceId,
    deviceLabel: screen.surface,
    city: null,
    openedAt: screen.openedAt,
  }));
}

/** The `UPDATE … WHERE id IN (…) RETURNING id` that ends active leases with one state. */
const CLOSE_ACTIVE = (state: PlaybackSessionState): string => `
  UPDATE playback_session
     SET state = '${state}', revoke_reason = $3, closed_at = $2
   WHERE id = ANY($1) AND state = ${ACTIVE}
  RETURNING id`;

/** $1 the instant, $2 the batch: the sweep skips what an opening, a renewal or a consumer holds. */
export const EXPIRE_LAPSED_SQL = `
  UPDATE playback_session
     SET state = '${PlaybackSessionState.EXPIRED}', closed_at = $1
   WHERE state = ${ACTIVE}
     AND id IN (SELECT id FROM playback_session
                 WHERE state = ${ACTIVE} AND lease_expires_at <= $1
                 ORDER BY lease_expires_at
                 LIMIT $2
                   FOR UPDATE SKIP LOCKED)
  RETURNING id`;

/** The device's active leases of the account, locked by id, then revoked: $5 and $6 narrow to a profile's. */
export const REVOKE_DEVICE_SQL = `
  UPDATE playback_session
     SET state = '${PlaybackSessionState.REVOKED}', revoke_reason = $3, closed_at = $4
   WHERE state = ${ACTIVE}
     AND id IN (SELECT id FROM playback_session
                 WHERE state = ${ACTIVE} AND account_id = $1 AND device_id = $2
                   AND ($5::uuid IS NULL OR profile_id = $5)
                   AND ($6::timestamptz IS NULL OR opened_at <= $6)
                 ORDER BY id
                   FOR UPDATE)
  RETURNING id`;

/** One transaction's statements on `playback_session`, every one conditioned on the state it moves. */
export class PlaybackSessions {
  public constructor(private readonly manager: EntityManager) {}

  /**
   * The lock order's first step (HANDOVER §0): the first opening of an account on a date has no
   *   row to lock, so an advisory lock on the pair serialises its screens.
   */
  public async lockScreens(accountId: string, dateId: string): Promise<void> {
    await this.manager.query(
      `SELECT pg_advisory_xact_lock(hashtext('screens:' || $1::text || ':' || $2::text))`,
      [accountId, dateId],
    );
  }

  /** The second step: the account's active leases on the date, locked by id. */
  public async activeOnDate(accountId: string, dateId: string): Promise<PlaybackSession[]> {
    const rows = await this.manager.query<SessionRow[]>(
      `SELECT * FROM playback_session
        WHERE account_id = $1 AND date_id = $2 AND state = ${ACTIVE}
        ORDER BY id
          FOR UPDATE`,
      [accountId, dateId],
    );
    return rows.map(sessionOf);
  }

  public async byId(id: string): Promise<PlaybackSession | null> {
    const [row] = await this.manager.query<SessionRow[]>(
      'SELECT * FROM playback_session WHERE id = $1',
      [id],
    );
    return row === undefined ? null : sessionOf(row);
  }

  /** False when a racing opening on the device won the one-active-lease index: answered as a resumption. */
  public async insert(opening: Opening): Promise<boolean> {
    const inserted = await this.manager.query<{ id: string }[]>(
      `INSERT INTO playback_session (id, account_id, profile_id, device_id, date_id, state, scope,
                                     session_scope, protocol, drm_system, quality_cap,
                                     edge_renewal_mode, surface, token_id, token_expires_at,
                                     lease_expires_at, opened_at, last_renewed_at)
            VALUES ($1, $2, $3, $4, $5, ${ACTIVE}, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                    $16, $16)
       ON CONFLICT (account_id, date_id, device_id) WHERE state = ${ACTIVE} DO NOTHING
         RETURNING id`,
      [
        opening.id,
        opening.accountId,
        opening.profileId,
        opening.deviceId,
        opening.dateId,
        opening.scope,
        opening.sessionScope,
        opening.protocol,
        opening.drmSystem,
        opening.qualityCap,
        opening.edgeRenewalMode,
        opening.surface,
        opening.tokenId,
        new Date(opening.tokenExpiresAt),
        new Date(opening.leaseExpiresAt),
        new Date(opening.at),
      ],
    );
    return inserted.length === 1;
  }

  /**
   * The device's lease taken over by its own opening: same id, a new token and lease, opened now,
   *   so a profile close older than the resumption spares it and the renewal ranks it newest.
   */
  public async reopen(id: string, reopening: Reopening): Promise<PlaybackSession | null> {
    const [row] = await updateReturning<SessionRow>(
      this.manager,
      `UPDATE playback_session
          SET profile_id = $2, scope = $3, protocol = $4, drm_system = $5, quality_cap = $6,
              edge_renewal_mode = $7, surface = $8, token_id = $9, token_expires_at = $10,
              lease_expires_at = $11, opened_at = $12, last_renewed_at = $12
        WHERE id = $1 AND state = ${ACTIVE}
        RETURNING *`,
      [
        id,
        reopening.profileId,
        reopening.scope,
        reopening.protocol,
        reopening.drmSystem,
        reopening.qualityCap,
        reopening.edgeRenewalMode,
        reopening.surface,
        reopening.tokenId,
        new Date(reopening.tokenExpiresAt),
        new Date(reopening.leaseExpiresAt),
        new Date(reopening.at),
      ],
    );
    return row === undefined ? null : sessionOf(row);
  }

  public async renew(id: string, issue: Issue): Promise<PlaybackSession | null> {
    const [row] = await updateReturning<SessionRow>(
      this.manager,
      `UPDATE playback_session
          SET scope = $2, token_id = $3, token_expires_at = $4, lease_expires_at = $5,
              last_renewed_at = $6
        WHERE id = $1 AND state = ${ACTIVE}
        RETURNING *`,
      [
        id,
        issue.scope,
        issue.tokenId,
        new Date(issue.tokenExpiresAt),
        new Date(issue.leaseExpiresAt),
        new Date(issue.at),
      ],
    );
    return row === undefined ? null : sessionOf(row);
  }

  public async revoke(ids: readonly string[], reason: RevokeReason, at: Instant): Promise<void> {
    if (ids.length === 0) return;
    await updateReturning(this.manager, CLOSE_ACTIVE(PlaybackSessionState.REVOKED), [
      ids,
      new Date(at),
      reason,
    ]);
  }

  public async expire(ids: readonly string[], at: Instant): Promise<void> {
    if (ids.length === 0) return;
    await updateReturning(this.manager, CLOSE_ACTIVE(PlaybackSessionState.EXPIRED), [
      ids,
      new Date(at),
      null,
    ]);
  }

  public async release(id: string, at: Instant): Promise<void> {
    await updateReturning(this.manager, CLOSE_ACTIVE(PlaybackSessionState.RELEASED), [
      [id],
      new Date(at),
      null,
    ]);
  }

  /**
   * Without the advisory lock: a consumer only revokes, and takes the rows by id as an opening does.
   *   A profile's close reaches only the leases opened at or before it.
   */
  public async revokeDevice(
    target: {
      readonly accountId: string;
      readonly deviceId: string;
      readonly profileId?: string;
      readonly openedAtOrBefore?: Instant;
    },
    reason: RevokeReason,
    at: Instant,
  ): Promise<number> {
    const revoked = await updateReturning<{ id: string }>(this.manager, REVOKE_DEVICE_SQL, [
      target.accountId,
      target.deviceId,
      reason,
      new Date(at),
      target.profileId ?? null,
      target.openedAtOrBefore === undefined ? null : new Date(target.openedAtOrBefore),
    ]);
    return revoked.length;
  }
}
