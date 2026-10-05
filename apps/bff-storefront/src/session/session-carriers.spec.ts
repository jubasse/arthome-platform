import { RefusalException } from '@arthome-platform/http-edge';
import { describe, expect, it, vi } from 'vitest';

import { SessionMode } from '@arthome/contracts/identity';

import {
  CSRF_COOKIE,
  CSRF_SECRET_COOKIE,
  SESSION_COOKIE,
  clearSessionCookies,
  presentedSession,
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
});
