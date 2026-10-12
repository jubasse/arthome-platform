import { updateReturning } from '@arthome-platform/transactions';
import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { Clock } from '@arthome/core';

import { digestOf, newDeviceToken } from './device-token.js';
import type { PresentedDevice } from './presented-device.schema.js';
import { CLOCK } from '../clock.js';

/** Core's `DEVICE_TOKEN_LIFETIME_SECONDS` from 0.4.0-rc.1 (CB1): this line goes when PI1 takes it. */
const DEVICE_TOKEN_LIFETIME_SECONDS = 180 * 24 * 60 * 60;

/** Two binds of one (device, profile) can race; the loser's second attempt replaces the winner. */
const BIND_ATTEMPTS = 2;

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
      const deviceSessionId = uuidv7();
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

  /** Closes the session's binding: it resolves to nothing from now on. */
  public async close(manager: EntityManager, authSessionId: string): Promise<void> {
    await manager.query(
      'UPDATE device_session SET closed_at = $2 WHERE auth_session_id = $1 AND closed_at IS NULL',
      [authSessionId, new Date(this.clock.nowMs())],
    );
  }
}
