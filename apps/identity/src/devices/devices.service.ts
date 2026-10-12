import { randomUUID } from 'node:crypto';

import { notFound } from '@arthome-platform/http-edge';
import { updateReturning } from '@arthome-platform/transactions';
import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { DEVICE_TOKEN_LIFETIME_SECONDS, type Clock } from '@arthome/core';

import {
  recordDeviceRevoked,
  recordDeviceSessionClosed,
  type ClosedBinding,
  type DeviceAct,
} from './device-events.js';
import { DeviceSession } from './device-session.entity.js';
import { digestOf, newDeviceToken } from './device-token.js';
import { Device } from './device.entity.js';
import type { PresentedDevice } from './presented-device.schema.js';
import { AUTH_SCHEMA } from '../auth/better-auth.js';
import { SIGNING_IN_STATUSES } from '../auth/signing-in-statuses.js';
import { CLOCK } from '../clock.js';

/** Two binds of one (device, profile) can race; the loser's second attempt replaces the winner. */
const BIND_ATTEMPTS = 2;

/**
 * Another account holds the device while one of its bindings there still resolves, as the resolve
 *   reads it: open, its better-auth session unexpired, its account still signing in. A binding no
 *   one closed after its session lapsed holds nothing.
 */
const STILL_HELD_SQL = `
  SELECT EXISTS (
    SELECT 1
      FROM device_session ds
      JOIN account a ON a.id = ds.account_id
      JOIN ${AUTH_SCHEMA}.session s ON s.id = ds.auth_session_id AND s."userId" = ds.account_id
     WHERE ds.device_id = $1
       AND ds.closed_at IS NULL
       AND a.status = ANY($2)
       AND s."expiresAt" > $3
  ) AS held`;

const CLOSED_BINDING_COLUMNS = 'id, device_id, account_id, profile_id, auth_session_id';

interface ClosedBindingRow {
  readonly id: string;
  readonly device_id: string;
  readonly account_id: string;
  readonly profile_id: string;
  readonly auth_session_id: string;
}

function closedBindingOf(row: ClosedBindingRow): ClosedBinding {
  return {
    deviceSessionId: row.id,
    deviceId: row.device_id,
    accountId: row.account_id,
    profileId: row.profile_id,
    authSessionId: row.auth_session_id,
  };
}

export interface RegisteredDevice {
  readonly deviceId: string;
  /** The raw token the BFF sets: returned once, never stored, logged or memorised. */
  readonly token: string;
}

export interface BindingRequest {
  readonly authSessionId: string;
  readonly deviceId: string;
  readonly accountId: string;
  readonly profileId: string;
}

export interface Bound {
  readonly deviceSessionId: string;
  /** better-auth sessions whose binding this one replaced, to delete once committed. */
  readonly replacedAuthSessionIds: readonly string[];
}

/** The registered device and its bindings (`data-model.md` §1.3), always in the caller's transaction. */
@Injectable()
export class DevicesService {
  public constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /**
   * The presented device, its token rotated, or a new device when the token is absent, unknown,
   *   expired or revoked: it never refuses. The rotation is one conditional UPDATE, so of two
   *   sign-ins presenting one token, one rotates it and the other registers a new device.
   */
  public async deviceFor(
    manager: EntityManager,
    presented: PresentedDevice,
  ): Promise<RegisteredDevice> {
    const now = new Date(this.clock.nowMs());
    const token = newDeviceToken();
    const expiresAt = new Date(this.clock.nowMs() + DEVICE_TOKEN_LIFETIME_SECONDS * 1000);
    if (presented.token !== null) {
      const [rotated] = await updateReturning<{ readonly id: string }>(
        manager,
        `UPDATE device
            SET token_hash = $2, token_expires_at = $3, last_seen_at = $4
          WHERE token_hash = $1 AND revoked_at IS NULL AND token_expires_at > $4
      RETURNING id`,
        [digestOf(presented.token), digestOf(token), expiresAt, now],
      );
      if (rotated !== undefined) return { deviceId: rotated.id, token };
    }
    const deviceId = uuidv7();
    await manager.query(
      `INSERT INTO device (id, token_hash, token_expires_at, kind, label, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [deviceId, digestOf(token), expiresAt, presented.kind, presented.label, now],
    );
    return { deviceId, token };
  }

  public async isRevoked(manager: EntityManager, deviceId: string): Promise<boolean> {
    const open = await manager.query<unknown[]>(
      'SELECT 1 FROM device WHERE id = $1 AND revoked_at IS NULL',
      [deviceId],
    );
    return open.length === 0;
  }

  /**
   * Binds a session to its (device, profile), closing the pair's open binding first: a second
   *   sign-in of one profile on one device replaces the first. A racing bind that wins the partial
   *   unique index in between leaves this insert with nothing; the second attempt replaces it.
   */
  public async bind(manager: EntityManager, request: BindingRequest): Promise<Bound> {
    const now = new Date(this.clock.nowMs());
    const replaced: string[] = [];
    for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt += 1) {
      const closed = await updateReturning<{ readonly auth_session_id: string }>(
        manager,
        `UPDATE device_session SET closed_at = $3
          WHERE device_id = $1 AND profile_id = $2 AND closed_at IS NULL
      RETURNING auth_session_id`,
        [request.deviceId, request.profileId, now],
      );
      replaced.push(...closed.map(({ auth_session_id }) => auth_session_id));
      const deviceSessionId = randomUUID();
      const inserted = await manager.query<unknown[]>(
        `INSERT INTO device_session
           (id, device_id, account_id, profile_id, auth_session_id, opened_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (device_id, profile_id) WHERE closed_at IS NULL DO NOTHING
         RETURNING id`,
        [
          deviceSessionId,
          request.deviceId,
          request.accountId,
          request.profileId,
          request.authSessionId,
          now,
        ],
      );
      if (inserted.length === 1) return { deviceSessionId, replacedAuthSessionIds: replaced };
    }
    throw new Error(
      `device ${request.deviceId} kept an open binding after ${BIND_ATTEMPTS} attempts`,
    );
  }

  /**
   * Closes the caller's open bindings on the device, one `identity.device_session.closed.v1` each,
   *   and revokes the device, with its `identity.device.revoked.v1`, once no other account holds a
   *   binding there that still resolves: a browser keeps one device across accounts, and one
   *   account never signs another out. The closing UPDATE is the check, under the device's row
   *   lock: unknown, revoked, or none of the caller's bindings left open (a concurrent close
   *   included): 404, as another account's device answers.
   */
  public async revoke(
    manager: EntityManager,
    deviceId: string,
    act: DeviceAct,
  ): Promise<readonly ClosedBinding[]> {
    const device = await manager.findOne(Device, {
      where: { id: deviceId },
      lock: { mode: 'pessimistic_write' },
    });
    if (device?.revoked_at !== null) throw notFound();
    const now = new Date(this.clock.nowMs());
    const closed = (
      await updateReturning<ClosedBindingRow>(
        manager,
        `UPDATE device_session SET closed_at = $3
          WHERE device_id = $1 AND account_id = $2 AND closed_at IS NULL
      RETURNING ${CLOSED_BINDING_COLUMNS}`,
        [deviceId, act.accountId, now],
      )
    ).map(closedBindingOf);
    if (closed.length === 0) throw notFound();
    for (const binding of closed) await recordDeviceSessionClosed(manager, binding, act, now);
    const [{ held }] = await manager.query<[{ held: boolean }]>(STILL_HELD_SQL, [
      deviceId,
      SIGNING_IN_STATUSES,
      now,
    ]);
    if (!held) {
      await manager.update(Device, { id: deviceId }, { revoked_at: now });
      await recordDeviceRevoked(
        manager,
        { deviceId, accountId: act.accountId, kind: device.kind },
        act,
        now,
      );
    }
    return closed;
  }

  /**
   * Closes one of the caller's device sessions, with its `identity.device_session.closed.v1`. Null
   *   when it was closed already, which writes nothing; another account's or an unknown one: 404.
   */
  public async closeSession(
    manager: EntityManager,
    deviceSessionId: string,
    act: DeviceAct,
  ): Promise<ClosedBinding | null> {
    const binding = await manager.findOne(DeviceSession, {
      where: { id: deviceSessionId },
      lock: { mode: 'pessimistic_write' },
    });
    if (binding?.account_id !== act.accountId) throw notFound();
    if (binding.closed_at !== null) return null;
    const now = new Date(this.clock.nowMs());
    await manager.update(DeviceSession, { id: deviceSessionId }, { closed_at: now });
    const closed: ClosedBinding = {
      deviceSessionId,
      deviceId: binding.device_id,
      accountId: binding.account_id,
      profileId: binding.profile_id,
      authSessionId: binding.auth_session_id,
    };
    await recordDeviceSessionClosed(manager, closed, act, now);
    return closed;
  }

  /**
   * Closes the signed-out session's binding, the device itself asking, and says so to streaming.
   *   A session with no open binding writes nothing: one never bound, or one closed already.
   */
  public async signOut(
    manager: EntityManager,
    authSessionId: string,
    act: Omit<DeviceAct, 'fromDeviceId'>,
  ): Promise<void> {
    const now = new Date(this.clock.nowMs());
    const [closed] = await updateReturning<ClosedBindingRow>(
      manager,
      `UPDATE device_session SET closed_at = $2
        WHERE auth_session_id = $1 AND closed_at IS NULL
    RETURNING ${CLOSED_BINDING_COLUMNS}`,
      [authSessionId, now],
    );
    if (closed === undefined) return;
    const binding = closedBindingOf(closed);
    await recordDeviceSessionClosed(
      manager,
      binding,
      { ...act, fromDeviceId: binding.deviceId },
      now,
    );
  }
}
