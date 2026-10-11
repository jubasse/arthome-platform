import type { MigrationInterface, QueryRunner } from 'typeorm';

import {
  DRM_SYSTEMS,
  EDGE_RENEWAL_MODES,
  PLAYBACK_PROTOCOLS,
  QUALITY_CAPS,
} from '@arthome/contracts/streaming';
import {
  IdentityErrorCode,
  PLAYBACK_SESSION_STATES,
  PlaybackSessionState,
  Surface,
  WATCH_DENIAL_REASONS,
  WatchScope,
} from '@arthome/core';

function oneOf(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * Playback's leases (PS3): one row per session, written by conditional statements. The unique
 *   partial index is the one active lease per device and also serves the screens' count; the two
 *   others are the revocation by device and the lease-expiry sweep.
 */
export class PlaybackSession1791722400000 implements MigrationInterface {
  name = 'PlaybackSession1791722400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const active = `'${PlaybackSessionState.ACTIVE}'`;
    await queryRunner.query(`
      CREATE TABLE playback_session (
        id uuid PRIMARY KEY,
        account_id uuid NOT NULL,
        profile_id uuid NOT NULL,
        device_id uuid NOT NULL,
        date_id uuid NOT NULL,
        state text NOT NULL CHECK (state IN (${oneOf(PLAYBACK_SESSION_STATES)})),
        revoke_reason text NULL
          CHECK (revoke_reason IN (${oneOf([...WATCH_DENIAL_REASONS, IdentityErrorCode.SIGNED_OUT_ELSEWHERE])})),
        scope text NOT NULL CHECK (scope IN (${oneOf([WatchScope.FULL, WatchScope.PREVIEW])})),
        session_scope text NOT NULL,
        protocol text NOT NULL CHECK (protocol IN (${oneOf(PLAYBACK_PROTOCOLS)})),
        drm_system text NULL CHECK (drm_system IN (${oneOf(DRM_SYSTEMS)})),
        quality_cap text NOT NULL CHECK (quality_cap IN (${oneOf(QUALITY_CAPS)})),
        edge_renewal_mode text NOT NULL CHECK (edge_renewal_mode IN (${oneOf(EDGE_RENEWAL_MODES)})),
        surface text NOT NULL
          CHECK (surface IN (${oneOf([Surface.STOREFRONT_WEB, Surface.STOREFRONT_MOBILE, Surface.STOREFRONT_TV])})),
        token_id uuid NOT NULL,
        token_expires_at timestamptz NOT NULL,
        lease_expires_at timestamptz NOT NULL,
        opened_at timestamptz NOT NULL,
        last_renewed_at timestamptz NOT NULL,
        closed_at timestamptz NULL,
        CHECK ((state = '${PlaybackSessionState.REVOKED}') = (revoke_reason IS NOT NULL)),
        CHECK ((state = ${active}) = (closed_at IS NULL))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX playback_session_one_active_per_device
          ON playback_session (account_id, date_id, device_id) WHERE state = ${active}
    `);
    await queryRunner.query(`
      CREATE INDEX playback_session_active_by_device
          ON playback_session (device_id) WHERE state = ${active}
    `);
    await queryRunner.query(`
      CREATE INDEX playback_session_lease_due
          ON playback_session (lease_expires_at) WHERE state = ${active}
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE playback_session');
  }
}
