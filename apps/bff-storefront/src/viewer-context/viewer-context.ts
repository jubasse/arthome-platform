import type { z } from 'zod';

import type { DomainConstantsSchema } from '@arthome/contracts/catalog';
import type { ViewerContextSchema } from '@arthome/contracts/identity';
import {
  CHAT_ALLOWANCE_BY_SURFACE,
  DomainConstant,
  PREVIEW_BUDGET_SECONDS,
  REMINDER_LEAD_MINUTES,
  REPLAY_EXPIRY_WARNING_HOURS,
  SCARCITY_THRESHOLD_BPS,
  WAITLIST_PRIORITY_HOURS,
  type StorefrontSurface,
} from '@arthome/core';

import type { ResolvedSession, ViewerAccount } from '../identity/identity-answers.schema.js';

type DomainConstants = z.input<typeof DomainConstantsSchema>;

export type ServedViewerContext = z.input<typeof ViewerContextSchema>;

/**
 * The constants a storefront surface is served, each read from its owner in core (rule 2). The
 *   reaction quota per date has no decided number, so it is omitted, as the contract allows.
 */
export function domainConstantsFor(surface: StorefrontSurface): DomainConstants {
  const chat = CHAT_ALLOWANCE_BY_SURFACE[surface];
  return {
    roomOpensMinutesBefore: DomainConstant.ROOM_OPENS_MINUTES_BEFORE,
    cancelDeadlineMinutesBefore: DomainConstant.CANCEL_DEADLINE_MINUTES_BEFORE,
    scarcityThresholdBps: SCARCITY_THRESHOLD_BPS,
    billboardPreviewDelaySec: DomainConstant.BILLBOARD_PREVIEW_DELAY_SECONDS,
    waitlistPriorityWindowHours: WAITLIST_PRIORITY_HOURS,
    chatRateLimitPerSecond: chat.messagesPerSecond,
    chatCatchUpMessages: chat.catchUpMessages,
    reminderLeadMinutes: REMINDER_LEAD_MINUTES,
    replayExpiryWarningHours: REPLAY_EXPIRY_WARNING_HOURS,
    previewSecondsTotal: PREVIEW_BUDGET_SECONDS,
    searchExactTotalLimit: DomainConstant.SEARCH_EXACT_TOTAL_LIMIT,
  };
}

/**
 * The bootstrap a signed-in viewer receives (`getViewerContext`, `SessionEstablished`'s
 *   `viewerContext` and `signOutProfile`): the registered device, and the session's profile as the
 *   current one and the only one listed, until a picker lists the account's others. The displayed
 *   plan comes with subscriptions, so it is absent, not null. No label catalogue or taxonomy is
 *   published yet, so both are null: the surface uses its embedded snapshot (context-map §1.8).
 */
export function viewerContextOf(
  session: Pick<ResolvedSession, 'deviceId' | 'profile'>,
  account: ViewerAccount,
  surface: StorefrontSurface,
): ServedViewerContext {
  const { id, name, kind } = session.profile;
  return {
    deviceId: session.deviceId,
    signedIn: true,
    currentProfileId: id,
    profiles: [{ id, name, kind }],
    account: { publicHandle: account.publicHandle, emailVerified: account.emailVerified },
    constants: domainConstantsFor(surface),
    labelCatalog: null,
    taxonomyArtifact: null,
  };
}

/** What a device holds once its own profile signed out: the device, and nobody on it. */
export function signedOutViewerContextOf(
  deviceId: string,
  surface: StorefrontSurface,
): ServedViewerContext {
  return {
    deviceId,
    signedIn: false,
    currentProfileId: null,
    profiles: [],
    account: null,
    constants: domainConstantsFor(surface),
    labelCatalog: null,
    taxonomyArtifact: null,
  };
}
