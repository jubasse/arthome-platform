import { RefusalException } from '@arthome-platform/http-edge';
import { describe, expect, it, vi } from 'vitest';

import { SessionMode } from '@arthome/contracts/identity';

import {
  CSRF_COOKIE,
  CSRF_SECRET_COOKIE,
  DEVICE_COOKIE,
  SESSION_COOKIE,
  clearDeviceCookie,
  clearSessionCookies,
  presentedDeviceToken,
  presentedSession,
  setDeviceCookie,
  setSessionCookies,
  type CookieReply,
  type CsrfReply,
} from './session-carriers.js';

describe('the session a request presents', () => {
  it('is the cookie, or the bearer token, or nothing', () => {
    expect(presentedSession({ headers: {}, cookies: { [SESSION_COOKIE]: 'a.b' } })).toEqual({
      token: 'a.b',
      carrier: SessionMode.COOKIE,
    });
    expect(presentedSession({ headers: { authorization: 'Bearer a.b%3D' } })).toEqual({
      token: 'a.b%3D',
      carrier: SessionMode.BEARER,
    });
    expect(presentedSession({ headers: {}, cookies: {} })).toBeNull();
  });

  it('is a 401 when both carriers come at once, or the header is not a bearer', () => {
    expect(() =>
      presentedSession({
        headers: { authorization: 'Bearer a.b' },
        cookies: { [SESSION_COOKIE]: 'c.d' },
      }),
    ).toThrow(RefusalException);
    expect(() => presentedSession({ headers: { authorization: 'Basic a.b' } })).toThrow(
      RefusalException,
    );
  });
});

describe('the session cookies', () => {
  function cookieReply() {
    const setCookie = vi.fn<CookieReply['setCookie']>();
    const clearCookie = vi.fn<CookieReply['clearCookie']>();
    const generateCsrf = vi.fn<CsrfReply['generateCsrf']>().mockReturnValue('csrf-token');
    return {
      reply: { setCookie, clearCookie, generateCsrf } satisfies CsrfReply,
      setCookie,
      clearCookie,
      generateCsrf,
    };
  }

  it('live as long as the session, the session one out of the page’s reach', () => {
    const { reply, setCookie } = cookieReply();
    setSessionCookies(
      reply,
      { headers: {} },
      { token: 'a.b', expiresAt: '2026-10-10T12:00:00.000Z' },
      Date.parse('2026-10-03T12:00:00.000Z'),
    );
    const week = 7 * 24 * 60 * 60;
    expect(setCookie).toHaveBeenCalledWith(SESSION_COOKIE, 'a.b', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: week,
    });
    expect(setCookie).toHaveBeenCalledWith(CSRF_COOKIE, 'csrf-token', {
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      maxAge: week,
    });
  });

  it('give the CSRF secret the session’s lifetime, whether minted now or already held', () => {
    const { reply, setCookie, generateCsrf } = cookieReply();
    const session = { token: 'a.b', expiresAt: '2026-10-10T12:00:00.000Z' };
    const week = 7 * 24 * 60 * 60;
    setSessionCookies(
      reply,
      { headers: {}, cookies: { [CSRF_SECRET_COOKIE]: 'held' } },
      session,
      Date.parse('2026-10-03T12:00:00.000Z'),
    );
    expect(generateCsrf).toHaveBeenCalledWith({ userInfo: 'a.b', maxAge: week });
    expect(setCookie).toHaveBeenCalledWith(CSRF_SECRET_COOKIE, 'held', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: week,
    });
  });

  it('are cleared with the attributes that set them', () => {
    const { reply, clearCookie } = cookieReply();
    clearSessionCookies(reply);
    expect(clearCookie).toHaveBeenCalledWith(SESSION_COOKIE, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
    expect(clearCookie).toHaveBeenCalledWith(CSRF_COOKIE, {
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
    });
    expect(clearCookie).toHaveBeenCalledWith(CSRF_SECRET_COOKIE, expect.anything());
  });

  it('leave the device cookie when they are cleared', () => {
    const { reply, clearCookie } = cookieReply();
    clearSessionCookies(reply);
    expect(clearCookie).not.toHaveBeenCalledWith(DEVICE_COOKIE, expect.anything());
  });
});

describe('the device cookie', () => {
  const deviceAttributes = { path: '/', httpOnly: true, secure: true, sameSite: 'lax' };

  it('is __Host-, out of the page’s reach, and lives the device token’s lifetime', () => {
    const setCookie = vi.fn<CookieReply['setCookie']>();
    setDeviceCookie({ setCookie, clearCookie: vi.fn() }, 'device-token');
    expect(DEVICE_COOKIE).toBe('__Host-arthome_device');
    expect(setCookie).toHaveBeenCalledExactlyOnceWith(DEVICE_COOKIE, 'device-token', {
      ...deviceAttributes,
      maxAge: 180 * 24 * 60 * 60,
    });
  });

  it('is cleared with the attributes that set it', () => {
    const clearCookie = vi.fn<CookieReply['clearCookie']>();
    clearDeviceCookie({ setCookie: vi.fn(), clearCookie });
    expect(clearCookie).toHaveBeenCalledExactlyOnceWith(DEVICE_COOKIE, deviceAttributes);
  });

  it('presents its token, or none when absent, empty, or longer than identity issues', () => {
    expect(presentedDeviceToken({ headers: {}, cookies: { [DEVICE_COOKIE]: 'held' } })).toBe(
      'held',
    );
    expect(presentedDeviceToken({ headers: {} })).toBeNull();
    expect(presentedDeviceToken({ headers: {}, cookies: { [DEVICE_COOKIE]: '' } })).toBeNull();
    expect(
      presentedDeviceToken({ headers: {}, cookies: { [DEVICE_COOKIE]: 'x'.repeat(513) } }),
    ).toBeNull();
  });
});
