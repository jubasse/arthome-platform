import { unauthenticated } from '@arthome-platform/http-edge';

import { SessionMode } from '@arthome/contracts/identity';

/**
 * `storefront.yaml`'s `sessionCookie`. `__Host-`, as the other two: a sibling subdomain cannot plant
 *   one, so it cannot slip its own session, and that session's CSRF pair, into a viewer's browser.
 */
export const SESSION_COOKIE = '__Host-arthome_session';
/** The CSRF token the page reads and echoes in `X-Arthome-Csrf` (storefront.yaml). */
export const CSRF_COOKIE = '__Host-arthome_csrf';
/** `@fastify/csrf-protection`'s secret, out of the page's reach. */
export const CSRF_SECRET_COOKIE = '__Host-arthome_csrf_secret';
export const CSRF_HEADER = 'x-arthome-csrf';

/** A session the request carries, in the one place it may. */
export interface PresentedSession {
  readonly token: string;
  readonly carrier: typeof SessionMode.COOKIE | typeof SessionMode.BEARER;
}

export interface CookieCarrier {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly cookies?: Readonly<Record<string, string | undefined>>;
}

/** Fastify's reply once `@fastify/cookie` decorates it. */
export interface CookieReply {
  setCookie(name: string, value: string, attributes: CookieAttributes): unknown;
  clearCookie(name: string, attributes: CookieAttributes): unknown;
}

/** And once `@fastify/csrf-protection` does: the options also become the new secret's attributes. */
export interface CsrfReply extends CookieReply {
  generateCsrf(options: { readonly userInfo: string; readonly maxAge: number }): string;
}

export interface CookieAttributes {
  readonly path: '/';
  readonly httpOnly: boolean;
  readonly secure: true;
  readonly sameSite: 'lax';
  readonly maxAge?: number;
}

/** `HttpOnly`, `Secure`, `SameSite=Lax`, on the BFF's host alone (adr-auth.md §8.2.4). */
const SESSION_ATTRIBUTES = {
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
} as const satisfies CookieAttributes;

/** Readable by the page, which echoes it: that is the double submit. */
const CSRF_ATTRIBUTES = { ...SESSION_ATTRIBUTES, httpOnly: false } as const;

export const CSRF_SECRET_ATTRIBUTES: CookieAttributes = SESSION_ATTRIBUTES;

/** A signed session token, percent-encoded when its signature needs it; identity verifies it. */
const BEARER = /^Bearer ([A-Za-z0-9._~+/=%-]+)$/;

/**
 * The session the request presents, or null when it presents none. Both carriers at once is a 401:
 *   a response never sets both (D-023), so a request holding both is not one of ours.
 */
export function presentedSession(request: CookieCarrier): PresentedSession | null {
  const cookie = request.cookies?.[SESSION_COOKIE];
  const header = request.headers.authorization;
  const bearer = typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined;
  if (typeof header === 'string' && bearer === undefined) throw unauthenticated();
  if (cookie !== undefined && cookie !== '' && bearer !== undefined) throw unauthenticated();
  if (cookie !== undefined && cookie !== '') return { token: cookie, carrier: SessionMode.COOKIE };
  if (bearer !== undefined) return { token: bearer, carrier: SessionMode.BEARER };
  return null;
}

/**
 * The session, the CSRF token bound to it and the secret behind that token, all three living as long
 *   as the session: a secret that ended with the browser left every later write a 403.
 */
export function setSessionCookies(
  reply: CsrfReply,
  request: CookieCarrier,
  session: { readonly token: string; readonly expiresAt: string },
  nowMs: number,
): void {
  const maxAge = Math.max(0, Math.floor((Date.parse(session.expiresAt) - nowMs) / 1000));
  const csrfToken = reply.generateCsrf({ userInfo: session.token, maxAge });
  // The plugin sets the secret only when it mints one: one the browser holds is re-set to slide.
  const heldSecret = request.cookies?.[CSRF_SECRET_COOKIE];
  if (heldSecret) {
    reply.setCookie(CSRF_SECRET_COOKIE, heldSecret, { ...CSRF_SECRET_ATTRIBUTES, maxAge });
  }
  reply.setCookie(SESSION_COOKIE, session.token, { ...SESSION_ATTRIBUTES, maxAge });
  reply.setCookie(CSRF_COOKIE, csrfToken, { ...CSRF_ATTRIBUTES, maxAge });
}

/** With exactly the attributes that set them, or a browser keeps them (storefront.yaml `signOut`). */
export function clearSessionCookies(reply: CookieReply): void {
  reply.clearCookie(SESSION_COOKIE, SESSION_ATTRIBUTES);
  reply.clearCookie(CSRF_COOKIE, CSRF_ATTRIBUTES);
  reply.clearCookie(CSRF_SECRET_COOKIE, CSRF_SECRET_ATTRIBUTES);
}
