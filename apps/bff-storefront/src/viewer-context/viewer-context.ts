import type { z } from 'zod';

import type { DomainConstantsSchema } from '@arthome/contracts/catalog';
import type { ViewerContextSchema } from '@arthome/contracts/identity';
import {
  CHAT_ALLOWANCE_BY_SURFACE,
  DomainConstant,
  REMINDER_LEAD_MINUTES,
  REPLAY_EXPIRY_WARNING_HOURS,
  SCARCITY_THRESHOLD_BPS,
  WAITLIST_PRIORITY_HOURS,
  type StorefrontSurface,
} from '@arthome/core';

import type { ResolvedSession, ViewerAccount } from '../identity/identity-answers.schema.js';

type DomainConstants = z.input<typeof DomainConstantsSchema>;
type ContractViewerContext = z.input<typeof ViewerContextSchema>;

/**
 * What no document owns yet, so this BFF does not serve it: the reaction quota per date has no
 *   decided number, and the label catalogue and taxonomy artifacts have no publication pipeline to
 *   name a version. Each is required by the contract; the gap is the type, so filling one is a
 *   compile error away from being noticed.
 */
type Unsourced = 'reactionQuotaPerDate';
type UnsourcedArtifacts = 'labelCatalog' | 'taxonomyArtifact';

export type ServedViewerContext = Omit<ContractViewerContext, UnsourcedArtifacts | 'constants'> & {
  readonly constants: Omit<DomainConstants, Unsourced>;
};

/** The constants a storefront surface is served, each read from its owner in core (rule 2). */
export function domainConstantsFor(surface: StorefrontSurface): Omit<DomainConstants, Unsourced> {
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
    searchExactTotalLimit: DomainConstant.SEARCH_EXACT_TOTAL_LIMIT,
  };
}

/**
 * The bootstrap a signed-in viewer receives (`getViewerContext`, and `SessionEstablished`'s
 *   `viewerContext`). Profiles come with the slice that creates them: none is current yet. The
 *   displayed plan comes with subscriptions, so it is absent, not null.
 */
export function viewerContextOf(
  session: Pick<ResolvedSession, 'deviceId'>,
  account: ViewerAccount,
  surface: StorefrontSurface,
): ServedViewerContext {
  return {
    deviceId: session.deviceId,
    signedIn: true,
    currentProfileId: null,
    profiles: [],
    account: { publicHandle: account.publicHandle, emailVerified: account.emailVerified },
    constants: domainConstantsFor(surface),
  };
}
