import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  appendSetCookies,
  relayedPlaybackCookies,
  type SetCookieReply,
} from './playback-cookies.js';
import { SESSION_COOKIE } from '../session/session-carriers.js';
import type * as SessionCarriers from '../session/session-carriers.js';

// The real names all carry `__Host-`, which the prefix rule catches first: one without it
//   reaches the own-names rule.
vi.mock(
  '../session/session-carriers.js',
  async (importOriginal): Promise<Record<string, unknown>> => {
    const original = await importOriginal<typeof SessionCarriers>();
    return { ...original, SESSION_COOKIE: 'arthome_session' };
  },
);

const VALUE = 'signed-ticket-value';
const EXPIRES = 'Expires=Mon, 12 Oct 2026 10:02:00 GMT';

function ticket(
  path: string,
  attributes = 'Secure; HttpOnly; SameSite=None',
  name = 'arthome_playback',
) {
  return `${name}=${VALUE}; Path=${path}; ${EXPIRES}; ${attributes}`;
}

let warned: MockInstance<Logger['warn']>;

beforeEach(() => {
  warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a streaming ticket cookie', () => {
  it('is relayed with the Domain appended, its own attributes untouched', () => {
    const line = ticket('/playback/d1/full/');

    expect(relayedPlaybackCookies([line], 'arthome.tv')).toEqual([`${line}; Domain=arthome.tv`]);
  });

  it('is relayed host-only when no Domain is configured', () => {
    const line = ticket('/playback/d1/full/');

    expect(relayedPlaybackCookies([line], null)).toEqual([line]);
  });

  it.each(['/playback/d1/preview/', '/watch/d1/'])('is relayed on %s', (path) => {
    expect(relayedPlaybackCookies([ticket(path)], null)).toHaveLength(1);
    expect(warned).not.toHaveBeenCalled();
  });

  it('keeps the order of several relayed lines', () => {
    const first = ticket('/playback/d1/full/', undefined, 'a');
    const second = ticket('/playback/d1/full/', undefined, 'b');

    expect(relayedPlaybackCookies([first, second], null)).toEqual([first, second]);
  });
});

describe('a cookie that is not a playback ticket', () => {
  it.each([
    ['path /', ticket('/'), /Path/],
    ['path /watchx/', ticket('/watchx/d1/'), /Path/],
    ['no Path', `arthome_playback=${VALUE}; Secure; HttpOnly`, /Path/],
    ['no HttpOnly', ticket('/playback/d1/full/', 'Secure; SameSite=None'), /HttpOnly/],
    ['no Secure', ticket('/playback/d1/full/', 'HttpOnly; SameSite=None'), /Secure/],
    ['a __Host- name', ticket('/playback/d1/full/', undefined, '__Host-ticket'), /prefix/],
    ['a __Secure- name', ticket('/playback/d1/full/', undefined, '__secure-ticket'), /prefix/],
    ['the BFF’s session name', ticket('/playback/d1/full/', undefined, SESSION_COOKIE), /BFF/],
    ['no name', '__Host-x; Path=/playback/d1/full/; Secure; HttpOnly', /no name/],
    ['an empty name', '=__Host-x=v; Path=/playback/d1/full/; Secure; HttpOnly', /no name/],
    ['its own Domain', ticket('/playback/d1/full/', 'Secure; HttpOnly; Domain=evil.tv'), /Domain/],
  ])('is dropped with %s, logged by name and never by value', (_, line, reason) => {
    expect(relayedPlaybackCookies([line], 'arthome.tv')).toEqual([]);
    expect(warned).toHaveBeenCalledOnce();
    const [message] = warned.mock.calls[0] ?? [];
    expect(String(message)).toMatch(reason);
    expect(String(message)).not.toContain(VALUE);
  });
});

/** A reply whose `header` replaces, the strictest an adapter can be. */
function replyHolding(held: string | string[] | undefined): SetCookieReply & { held(): unknown } {
  let current: string | string[] | undefined = held;
  return {
    getHeader: () => current,
    removeHeader: () => (current = undefined),
    header: (_, value) => (current = value),
    held: () => current,
  };
}

describe('appending the relayed cookies', () => {
  it('keeps every Set-Cookie the reply already holds, before them', () => {
    const reply = replyHolding('__Host-arthome_csrf=c; Path=/');

    appendSetCookies(reply, ['arthome_playback=t; Path=/playback/d1/full/']);

    expect(reply.held()).toEqual([
      '__Host-arthome_csrf=c; Path=/',
      'arthome_playback=t; Path=/playback/d1/full/',
    ]);
  });

  it('leaves the reply alone when nothing is relayed', () => {
    const reply = replyHolding(['a=1', 'b=2']);

    appendSetCookies(reply, []);

    expect(reply.held()).toEqual(['a=1', 'b=2']);
  });
});
