import { randomBytes, randomUUID } from 'node:crypto';

import type { QualityCap } from '@arthome/contracts/streaming';
import {
  PLAYBACK_RENEWAL_INTERVAL_SECONDS,
  WatchScope,
  playbackTokenExpiresAt,
  previewRenewAfterSeconds,
  type Instant,
} from '@arthome/core';

import type { PlaybackClaims } from '../media/media-ports.js';

/** What a ticket carries: a ticket exists only where playback was allowed, so never `none`. */
export type TicketScope = typeof WatchScope.FULL | typeof WatchScope.PREVIEW;

export interface TokenSubject {
  readonly profileId: string;
  readonly deviceId: string;
  readonly dateId: string;
  readonly sessionId: string;
  readonly qualityCap: QualityCap;
  readonly scope: TicketScope;
}

/** A fresh `jti` at every issue, kept on the session, so one token can be named for revocation. */
export function playbackClaimsOf(subject: TokenSubject, tokenId: string): PlaybackClaims {
  return {
    sub: subject.profileId,
    did: subject.deviceId,
    dat: subject.dateId,
    sid: subject.sessionId,
    qmax: subject.qualityCap,
    scope: subject.scope,
    jti: tokenId,
  };
}

export function newTokenId(): string {
  return randomUUID();
}

/** Random per session and stable across its renewals: the signed prefix, so the manifest URL never moves. */
export function newSessionScope(): string {
  return randomBytes(16).toString('base64url');
}

/** A full token lives core's 120 s; a preview's never outlives the budget the meter covers. */
export function tokenExpiresAt(
  scope: TicketScope,
  now: Instant,
  previewCover: Instant | null,
): Instant {
  if (scope === WatchScope.FULL) return playbackTokenExpiresAt(now);
  if (previewCover === null) throw new Error('a preview token is never issued without a cover');
  return previewCover;
}

export function renewAfterSecondsOf(scope: TicketScope, previewSecondsLeft: number): number {
  return scope === WatchScope.PREVIEW
    ? previewRenewAfterSeconds(previewSecondsLeft)
    : PLAYBACK_RENEWAL_INTERVAL_SECONDS;
}
