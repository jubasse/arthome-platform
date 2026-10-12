import { describe, expect, it } from 'vitest';

import { CHAT_ALLOWANCE_BY_SURFACE, DomainConstant, Surface } from '@arthome/core';

import { domainConstantsFor, signedOutViewerContextOf, viewerContextOf } from './viewer-context.js';

const DEVICE = '019a0000-0000-7000-8000-00000000d0d0';
const PROFILE = { id: '019a0000-0000-7000-8000-0000000000f1', name: 'Marie', kind: 'adult' };

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

  it('is signed in on the registered device, its profile current and listed, no plan', () => {
    const context = viewerContextOf(
      { deviceId: DEVICE, profile: { ...PROFILE, extra: 'not served' } },
      { publicHandle: '@viewer.abcdefgh', emailVerified: false },
      Surface.STOREFRONT_WEB,
    );
    expect(context).toMatchObject({
      deviceId: DEVICE,
      signedIn: true,
      currentProfileId: PROFILE.id,
      account: { publicHandle: '@viewer.abcdefgh', emailVerified: false },
    });
    expect(context.profiles).toEqual([PROFILE]);
    expect(context).not.toHaveProperty('plan');
  });

  it('holds the device and nobody once its own profile signed out', () => {
    expect(signedOutViewerContextOf(DEVICE, Surface.STOREFRONT_WEB)).toMatchObject({
      deviceId: DEVICE,
      signedIn: false,
      currentProfileId: null,
      profiles: [],
      account: null,
      constants: domainConstantsFor(Surface.STOREFRONT_WEB),
    });
  });
});
