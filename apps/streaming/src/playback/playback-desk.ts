import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import {
  PlaybackSessionState,
  WatchDenialReason,
  WatchScope,
  playbackLeaseExpiresAt,
  type Clock,
  type Instant,
  type StorefrontSurface,
} from '@arthome/core';

import { playbackFormatFor, type DeclaredCapabilities } from './playback-format.js';
import {
  PlaybackSessions,
  type Issue,
  type PlaybackSession,
  type Reopening,
  type RevokeReason,
  activeScreensOf,
  type ActiveScreen,
} from './playback-sessions.js';
import { PREVIEW_METER, type PreviewMeter } from './preview-meter.js';
import {
  holdsAScreen,
  leasesTakenOverBy,
  newerScreensThan,
  resumableLeaseOf,
} from './screen-allowance.js';
import {
  newSessionScope,
  newTokenId,
  playbackClaimsOf,
  renewAfterSecondsOf,
  tokenExpiresAt,
  type TicketScope,
} from './token-claims.js';
import { screensAllowedBy, verdictOf, type Verdict } from './watch-verdict.js';
import { CLOCK } from '../clock.js';
import { readEntitlementFacts } from '../entitlement/entitlement-facts.js';
import type { PlaybackProvider, SignedPlayback } from '../media/media-ports.js';
import { PLAYBACK_PROVIDER } from '../media/media-tokens.js';
import { readRunFacts, type RunIncidentFacts } from '../run/run-facts.js';
import { StreamingTransactions } from '../streaming-transactions.js';

/** The verified caller: the account, the profile and the device the BFF minted from the session. */
export interface Viewer {
  readonly accountId: string;
  readonly profileId: string;
  readonly deviceId: string;
}

export interface OpeningRequest {
  readonly viewer: Viewer;
  readonly dateId: string;
  readonly surface: StorefrontSurface;
  readonly viewerCountry: string;
  readonly capabilities: DeclaredCapabilities | undefined;
}

export interface ScreensRefusal {
  readonly refusedWith: typeof WatchDenialReason.CONCURRENT_LIMIT_REACHED;
  readonly allowed: number;
  readonly activeSessions: ActiveScreen[];
}

type WithoutScreens<Reason> = Exclude<Reason, typeof WatchDenialReason.CONCURRENT_LIMIT_REACHED>;

/** The refusals of a reason set: not found, one reason alone, or the screens' with their list. */
export type Refusal<Reason extends RevokeReason> =
  | { readonly refusedWith: 'not_found' }
  | { readonly refusedWith: WithoutScreens<Reason> }
  | ScreensRefusal;

export type OpeningRefusal = Refusal<WatchDenialReason>;
export type RenewalRefusal = Refusal<RevokeReason>;

export interface Issued {
  readonly session: PlaybackSession;
  readonly signed: SignedPlayback;
  readonly renewAfterSec: number;
  readonly previewSecondsLeft: number;
}

export interface Opened extends Issued {
  readonly refusedWith?: undefined;
  readonly resumedExistingSession: boolean;
  readonly incident: RunIncidentFacts | null;
}

export interface Renewed extends Issued {
  readonly refusedWith?: undefined;
}

const NOT_FOUND = { refusedWith: 'not_found' } as const;

/** `watch.concurrent_limit_reached` is served with the screens, so the surface can offer to release one. */
function refusalFor<Reason extends RevokeReason>(
  reason: Reason,
  listed: () => ScreensRefusal,
): Refusal<Reason> {
  return reason === WatchDenialReason.CONCURRENT_LIMIT_REACHED
    ? listed()
    : { refusedWith: reason as WithoutScreens<Reason> };
}

/**
 * The only evaluation of the right that produces a token (`adr-stream-entitlement.md` §3). An
 *   opening and a renewal take one lock order (HANDOVER §0): the account's screens on the date by
 *   advisory lock, their leases by id, the preview budget last. Signing is local crypto inside the
 *   transaction, so a provider that cannot sign rolls the lease back.
 */
@Injectable()
export class PlaybackDesk {
  public constructor(
    private readonly transactions: StreamingTransactions,
    @Inject(PLAYBACK_PROVIDER) private readonly provider: PlaybackProvider,
    @Inject(PREVIEW_METER) private readonly previewMeter: PreviewMeter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public open(request: OpeningRequest): Promise<Opened | OpeningRefusal> {
    const { viewer, dateId } = request;
    return this.transactions.run(async ({ manager }) => {
      const now = this.clock.now();
      const sessions = new PlaybackSessions(manager);
      await sessions.lockScreens(viewer.accountId, dateId);
      const active = await sessions.activeOnDate(viewer.accountId, dateId);
      const facts = await readEntitlementFacts(manager, {
        accountId: viewer.accountId,
        dateId,
        now,
      });
      if (facts.date === null) return NOT_FOUND;
      const run = await readRunFacts(manager, dateId);

      const screens = active.filter((lease) => holdsAScreen(lease, now));
      const resumed = resumableLeaseOf(screens, viewer.deviceId, now);
      const otherScreens = screens.filter((lease) => lease.deviceId !== viewer.deviceId);
      const allowed = screensAllowedBy(facts);
      const takenOver = leasesTakenOverBy(otherScreens, allowed);
      const previewSecondsLeft = await this.previewMeter.secondsLeft(
        manager,
        viewer.accountId,
        dateId,
        now,
      );
      const verdict = verdictOf(
        facts,
        run,
        { open: otherScreens.length - takenOver.length, allowed },
        previewSecondsLeft,
        request.viewerCountry,
        now,
      );
      const issue = await this.issueFor(manager, verdict, viewer.accountId, dateId, now);
      if ('refusedWith' in issue) {
        return refusalFor<WatchDenialReason>(issue.refusedWith, () => ({
          refusedWith: WatchDenialReason.CONCURRENT_LIMIT_REACHED,
          allowed,
          activeSessions: activeScreensOf(screens, viewer.deviceId),
        }));
      }

      await sessions.expire(
        active.filter((lease) => !holdsAScreen(lease, now)).map(({ id }) => id),
        now,
      );
      await sessions.revoke(
        takenOver.map(({ id }) => id),
        WatchDenialReason.CONCURRENT_LIMIT_REACHED,
        now,
      );
      const format = playbackFormatFor(
        this.provider.playbackCapabilities,
        request.capabilities,
        request.surface,
      );
      const reopening: Reopening = {
        ...issue,
        profileId: viewer.profileId,
        protocol: format.protocol,
        drmSystem: format.drmSystem,
        qualityCap: format.qualityCap,
        edgeRenewalMode: format.mechanism,
        surface: request.surface,
      };
      const { session, resumedExistingSession } = await this.leaseFor(
        sessions,
        request,
        resumed?.id ?? null,
        reopening,
      );
      return {
        session,
        resumedExistingSession,
        signed: await this.sign(session),
        renewAfterSec: renewAfterSecondsOf(issue.scope, verdict.previewSecondsLeft),
        previewSecondsLeft: verdict.previewSecondsLeft,
        incident: run?.incident ?? null,
      };
    });
  }

  /**
   * A released, expired or lapsed lease answers not found, and the player reopens with its device,
   *   which runs the whole decision again. A refusal is committed with the lease it revokes.
   */
  public renew(
    viewer: Viewer,
    sessionId: string,
    viewerCountry: string,
    assertHeldByCaller: (session: PlaybackSession) => void,
  ): Promise<Renewed | RenewalRefusal> {
    return this.transactions.run(async ({ manager }) => {
      const now = this.clock.now();
      const sessions = new PlaybackSessions(manager);
      const found = await sessions.byId(sessionId);
      if (found?.accountId !== viewer.accountId) return NOT_FOUND;
      assertHeldByCaller(found);

      await sessions.lockScreens(viewer.accountId, found.dateId);
      const active = await sessions.activeOnDate(viewer.accountId, found.dateId);
      const screens = active.filter((lease) => holdsAScreen(lease, now));
      const facts = await readEntitlementFacts(manager, {
        accountId: viewer.accountId,
        dateId: found.dateId,
        now,
      });
      const listed = (): ScreensRefusal => ({
        refusedWith: WatchDenialReason.CONCURRENT_LIMIT_REACHED,
        allowed: screensAllowedBy(facts),
        activeSessions: activeScreensOf(
          screens.filter(({ id }) => id !== sessionId),
          viewer.deviceId,
        ),
      });

      const lease = active.find(({ id }) => id === sessionId);
      if (lease === undefined) {
        const current = await sessions.byId(sessionId);
        if (current?.state !== PlaybackSessionState.REVOKED || current.revokeReason === null) {
          return NOT_FOUND;
        }
        return refusalFor<RevokeReason>(current.revokeReason, listed);
      }
      if (!holdsAScreen(lease, now)) {
        await sessions.expire([lease.id], now);
        return NOT_FOUND;
      }

      const run = await readRunFacts(manager, found.dateId);
      const previewSecondsLeft = await this.previewMeter.secondsLeft(
        manager,
        viewer.accountId,
        found.dateId,
        now,
      );
      const verdict = verdictOf(
        facts,
        run,
        { open: newerScreensThan(lease, screens, now), allowed: screensAllowedBy(facts) },
        previewSecondsLeft,
        viewerCountry,
        now,
      );
      const issue = await this.issueFor(manager, verdict, viewer.accountId, found.dateId, now);
      if ('refusedWith' in issue) {
        await sessions.revoke([lease.id], issue.refusedWith, now);
        return refusalFor<RevokeReason>(issue.refusedWith, listed);
      }
      const renewed = await sessions.renew(lease.id, issue);
      if (renewed === null) throw new Error(`the locked lease ${lease.id} was not active`);
      return {
        session: renewed,
        signed: await this.sign(renewed),
        renewAfterSec: renewAfterSecondsOf(issue.scope, verdict.previewSecondsLeft),
        previewSecondsLeft: verdict.previewSecondsLeft,
      };
    });
  }

  /** False for an unknown session or another account's; released, expired or revoked release again. */
  public release(accountId: string, sessionId: string): Promise<boolean> {
    return this.transactions.run(async ({ manager }) => {
      const sessions = new PlaybackSessions(manager);
      const found = await sessions.byId(sessionId);
      if (found?.accountId !== accountId) return false;
      await sessions.release(found.id, this.clock.now());
      return true;
    });
  }

  /** The token's scope and expiry for an allowed verdict; a preview the meter cannot cover is spent. */
  private async issueFor(
    manager: EntityManager,
    verdict: Verdict,
    accountId: string,
    dateId: string,
    now: Instant,
  ): Promise<Issue | { readonly refusedWith: WatchDenialReason }> {
    if (!verdict.allowed || verdict.reason !== null || verdict.scope === WatchScope.NONE) {
      return { refusedWith: verdict.reason ?? WatchDenialReason.NOT_PUBLISHED };
    }
    const scope: TicketScope = verdict.scope;
    const cover =
      scope === WatchScope.PREVIEW
        ? await this.previewMeter.cover(manager, accountId, dateId, now)
        : null;
    if (scope === WatchScope.PREVIEW && cover === null) {
      return { refusedWith: WatchDenialReason.PREVIEW_EXHAUSTED };
    }
    return {
      scope,
      tokenId: newTokenId(),
      tokenExpiresAt: tokenExpiresAt(scope, now, cover),
      leaseExpiresAt: playbackLeaseExpiresAt(now),
      at: now,
    };
  }

  private async leaseFor(
    sessions: PlaybackSessions,
    { viewer, dateId }: OpeningRequest,
    resumedId: string | null,
    reopening: Reopening,
  ): Promise<{ session: PlaybackSession; resumedExistingSession: boolean }> {
    if (resumedId === null) {
      const id = randomUUID();
      const inserted = await sessions.insert({
        ...reopening,
        id,
        accountId: viewer.accountId,
        deviceId: viewer.deviceId,
        dateId,
        sessionScope: newSessionScope(),
      });
      const session = inserted ? await sessions.byId(id) : null;
      if (session !== null) return { session, resumedExistingSession: false };
    }
    // A racing opening on the same device won the one-active-lease index: answered as a resumption.
    const own =
      resumedId ??
      (await sessions.activeOnDate(viewer.accountId, dateId)).find(
        (lease) => lease.deviceId === viewer.deviceId,
      )?.id;
    const session = own === undefined ? null : await sessions.reopen(own, reopening);
    if (session === null) throw new Error(`no active lease to resume on device ${viewer.deviceId}`);
    return { session, resumedExistingSession: true };
  }

  private sign(session: PlaybackSession): Promise<SignedPlayback> {
    return this.provider.sign({
      dateId: session.dateId,
      sessionScope: session.sessionScope,
      claims: playbackClaimsOf(
        {
          profileId: session.profileId,
          deviceId: session.deviceId,
          dateId: session.dateId,
          sessionId: session.id,
          qualityCap: session.qualityCap,
          scope: session.scope,
        },
        session.tokenId,
      ),
      expiresAt: session.tokenExpiresAt,
      mechanism: session.edgeRenewalMode,
    });
  }
}
