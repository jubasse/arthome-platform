import { describe, expect, it } from 'vitest';

import { CHAT_ALLOWANCE_BY_SURFACE, DomainConstant, Surface } from '@arthome/core';

import { domainConstantsFor, viewerContextOf } from './viewer-context.js';

describe('the viewer context', () => {
  it('serves each surface its own chat allowance, and core’s constants', () => {
    for (const surface of [
      Surface.STOREFRONT_WEB,
      Surface.STOREFRONT_MOBILE,
      Surface.STOREFRONT_TV,
    ]) {
      expect(domainConstantsFor(surface)).toMatchObject({
        chatRateLimitPerSecond: CHAT_ALLOWANCE_BY_SURFACE[surface].messagesPerSecond,
        chatCatchUpMessages: CHAT_ALLOWANCE_BY_SURFACE[surface].catchUpMessages,
        roomOpensMinutesBefore: DomainConstant.ROOM_OPENS_MINUTES_BEFORE,
        billboardPreviewDelaySec: DomainConstant.BILLBOARD_PREVIEW_DELAY_SECONDS,
      });
    }
  });

  it('is signed in, with no profile current yet and no plan, absent rather than null', () => {
    const context = viewerContextOf(
      { deviceId: '019a0000-0000-7000-8000-00000000d0d0' },
      { publicHandle: '@viewer.abcdefgh', emailVerified: false },
      Surface.STOREFRONT_WEB,
    );
    expect(context).toMatchObject({
      deviceId: '019a0000-0000-7000-8000-00000000d0d0',
      signedIn: true,
      currentProfileId: null,
      profiles: [],
      account: { publicHandle: '@viewer.abcdefgh', emailVerified: false },
    });
    expect(context).not.toHaveProperty('plan');
  });
});
