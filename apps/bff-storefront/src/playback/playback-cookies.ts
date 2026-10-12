import { Logger } from '@nestjs/common';

import {
  CSRF_COOKIE,
  CSRF_SECRET_COOKIE,
  DEVICE_COOKIE,
  SESSION_COOKIE,
} from '../session/session-carriers.js';

/**
 * The paths a provider signs its ticket under: the fake and CDN providers on `/playback/`,
 *   MediaMTX's edge on `/watch/<dateId>/` (PM1).
 */
export const PLAYBACK_COOKIE_PATH_PREFIXES = ['/playback/', '/watch/'] as const;

const OWN_COOKIES: ReadonlySet<string> = new Set([
  SESSION_COOKIE,
  CSRF_COOKIE,
  CSRF_SECRET_COOKIE,
  DEVICE_COOKIE,
]);

/** A browser gives these prefixes guarantees about who set them, which a relayed cookie would forge. */
const BROWSER_GUARDED_PREFIXES = ['__host-', '__secure-'];

const logger = new Logger('PlaybackCookies');

interface ParsedCookie {
  readonly name: string;
  /** Attribute names lower-cased, mapped to their values ('' for a flag). */
  readonly attributes: ReadonlyMap<string, string>;
}

function parsed(line: string): ParsedCookie {
  const [pair = '', ...attributes] = line.split(';');
  const separator = pair.indexOf('=');
  return {
    name: (separator === -1 ? '' : pair.slice(0, separator)).trim(),
    attributes: new Map(
      attributes.map((attribute) => {
        const equals = attribute.indexOf('=');
        return equals === -1
          ? [attribute.trim().toLowerCase(), '']
          : [attribute.slice(0, equals).trim().toLowerCase(), attribute.slice(equals + 1).trim()];
      }),
    ),
  };
}

/** Why the cookie is not relayed, or null when it is a playback ticket's. */
function refusalOf({ name, attributes }: ParsedCookie): string | null {
  if (name === '') return 'it has no name';
  const lowerName = name.toLowerCase();
  if (BROWSER_GUARDED_PREFIXES.some((prefix) => lowerName.startsWith(prefix))) {
    return 'its name has a prefix the browser guards';
  }
  if (OWN_COOKIES.has(name)) return 'its name is one of the BFF’s own';
  const path = attributes.get('path') ?? '';
  if (!PLAYBACK_COOKIE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return 'its Path is outside the playback prefixes';
  }
  if (!attributes.has('secure')) return 'it is not Secure';
  if (!attributes.has('httponly')) return 'it is not HttpOnly';
  // The Domain is the BFF's to give: one from streaming would widen the cookie past it.
  if (attributes.has('domain')) return 'it names its own Domain';
  return null;
}

/**
 * The streaming `Set-Cookie` lines a browser may receive, scoped by `domain` when set (host-only
 *   otherwise): a ticket cookie on a playback path, `Secure` and `HttpOnly`, that cannot pass for
 *   one of the BFF's own. Every other line is dropped and logged by name, never by value.
 */
export function relayedPlaybackCookies(
  setCookies: readonly string[],
  domain: string | null,
): string[] {
  return setCookies.flatMap((line) => {
    const cookie = parsed(line);
    const refusal = refusalOf(cookie);
    if (refusal !== null) {
      logger.warn(`streaming cookie ${cookie.name || '(unnamed)'} not relayed: ${refusal}`);
      return [];
    }
    return [domain === null ? line : `${line}; Domain=${domain}`];
  });
}

export interface SetCookieReply {
  getHeader(name: 'set-cookie'): string | string[] | number | undefined;
  removeHeader(name: 'set-cookie'): unknown;
  header(name: 'set-cookie', value: string[]): unknown;
}

/** Adds `cookies` after any `Set-Cookie` the reply already holds, which stay as they are. */
export function appendSetCookies(reply: SetCookieReply, cookies: readonly string[]): void {
  if (cookies.length === 0) return;
  const held = reply.getHeader('set-cookie');
  const kept = held === undefined ? [] : Array.isArray(held) ? held : [String(held)];
  reply.removeHeader('set-cookie');
  reply.header('set-cookie', [...kept, ...cookies]);
}
