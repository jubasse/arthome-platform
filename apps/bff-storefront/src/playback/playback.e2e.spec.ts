import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DEADLINE_HEADER, serveEndpoints } from '@arthome-platform/http-edge';
import { Logger } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiErrorCode,
  ChatMode,
  DisplayState,
  FailureNature,
  FixedClock,
  IdentityErrorCode,
  OrderErrorCode,
  Service,
  Surface,
  WatchDenialReason,
  WatchScope,
  audienceOf,
} from '@arthome/core';

import { PLAYBACK_COOKIE_DOMAIN } from './playback.controller.js';
import { STREAMING_URL } from './streaming.client.js';
import { AppModule } from '../app.module.js';
import { VIEWER_COUNTRY_HEADER } from '../auth/auth.controller.js';
import { CLOCK } from '../clock.js';
import { IDENTITY_URL } from '../identity/identity.client.js';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  CSRF_SECRET_COOKIE,
  SESSION_COOKIE,
} from '../session/session-carriers.js';

/**
 * The player's three routes through the whole app, against a stand-in identity that answers PI1's
 *   resolve (S3) and a stand-in streaming that answers its C3 routes by the date or session asked.
 */

const ACCOUNT = '01a0e700-0000-7000-8000-0000000000c1';
const DEVICE = '01a0e700-0000-7000-8000-0000000000d1';
const DEVICE_SESSION = '01a0e700-0000-7000-8000-0000000000e1';
const PROFILE = { id: '01a0e700-0000-7000-8000-0000000000f1', name: 'Marie', kind: 'adult' };
const COOKIE_TOKEN = 'sess_cookie';
const BEARER_TOKEN = 'sess_bearer';

const DATE = '01a0e700-0000-7000-8000-00000000da01';
const DATE_FULL = '01a0e700-0000-7000-8000-00000000da02';
const DATE_REPLAY_EXPIRED = '01a0e700-0000-7000-8000-00000000da03';
const DATE_UNDECLARED = '01a0e700-0000-7000-8000-00000000da04';
const DATE_SILENT = '01a0e700-0000-7000-8000-00000000da05';
const PLAYBACK_SESSION = '01a0e700-0000-7000-8000-00000000ab01';
const SIGNED_OUT_SESSION = '01a0e700-0000-7000-8000-00000000ab02';

const COOKIE_DOMAIN = 'arthome.tv';
const COUNTRY_HEADER = 'x-geo-country';
const TICKET_VALUE = 'ticket-signature-never-logged';
const RENEWED_VALUE = 'renewed-signature-never-logged';
const STRAY_VALUE = 'stray-cookie-never-logged';
const ticketCookie = (value: string) =>
  `arthome_playback=${value}; Path=/playback/${DATE}/full/; ` +
  'Expires=Mon, 12 Oct 2026 10:02:00 GMT; Secure; HttpOnly; SameSite=None';

const TICKET = {
  sessionId: PLAYBACK_SESSION,
  resumedExistingSession: false,
  dateId: DATE,
  scope: WatchScope.FULL,
  previewSecondsLeft: null,
  protocol: 'hls',
  drmSystem: null,
  qualityCap: 'hd',
  manifestUrl: `https://edge.arthome.tv/playback/${DATE}/full/index.m3u8`,
  signature: { queryToken: null, cookieSet: true },
  edgeRenewalMode: 'signed_cookie',
  expiresAt: '2026-10-12T10:02:00.000Z',
  renewAfterSec: 45,
  leaseExpiresAt: '2026-10-12T10:01:30.000Z',
  resumePoint: null,
  chatMode: ChatMode.OFF,
  incident: null,
};

const RENEWAL = {
  expiresAt: '2026-10-12T10:03:00.000Z',
  renewAfterSec: 45,
  leaseExpiresAt: '2026-10-12T10:02:30.000Z',
  signature: { queryToken: null, cookieSet: true },
  qualityCap: 'hd',
};

const ACTIVE_SESSIONS = [
  {
    sessionId: PLAYBACK_SESSION,
    deviceLabel: 'Téléviseur du salon',
    openedAt: '2026-10-12T09:00:00.000Z',
  },
];

interface StreamingCall {
  readonly path: string;
  readonly body: unknown;
  readonly headers: IncomingMessage['headers'];
  readonly claims: Record<string, unknown>;
}

const calls: StreamingCall[] = [];
const tokens: string[] = [];
let identityStandIn: Server;
let streamingStandIn: Server;
let app: NestFastifyApplication;
const clock = new FixedClock(Date.now() + 3_600_000);

function answer(
  response: ServerResponse,
  status: number,
  body: object,
  headers: Record<string, string | string[]> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify({ servedAt: '2026-10-12T10:00:00.000Z', ...body }));
}

function refused(
  response: ServerResponse,
  status: number,
  code: string,
  params: object = {},
): void {
  answer(response, status, {
    error: {
      code,
      nature: FailureNature.REFUSED,
      params,
      traceId: '0af7651916cd43dd8448eb211c80319c',
    },
  });
}

function bodyOf(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => resolve(body));
  });
}

function streaming(request: IncomingMessage, response: ServerResponse, body: string): void {
  const path = request.url ?? '';
  const token = (request.headers.authorization ?? '').replace('Bearer ', '');
  tokens.push(token);
  calls.push({
    path,
    body: body === '' ? undefined : JSON.parse(body),
    headers: request.headers,
    claims: decodeJwt(token),
  });
  if (path === `/v1/playback/${DATE}/open`) {
    answer(
      response,
      200,
      { data: TICKET },
      {
        'set-cookie': [
          ticketCookie(TICKET_VALUE),
          `stray=${STRAY_VALUE}; Path=/; Secure; HttpOnly`,
        ],
      },
    );
  } else if (path === `/v1/playback/${DATE_FULL}/open`) {
    refused(response, 403, WatchDenialReason.CONCURRENT_LIMIT_REACHED, {
      allowed: 1,
      activeSessions: ACTIVE_SESSIONS,
    });
  } else if (path === `/v1/playback/${DATE_REPLAY_EXPIRED}/open`) {
    refused(response, 410, WatchDenialReason.REPLAY_EXPIRED);
  } else if (path === `/v1/playback/${DATE_UNDECLARED}/open`) {
    refused(response, 409, OrderErrorCode.SOLD_OUT);
  } else if (path === `/v1/playback/${DATE_SILENT}/open`) {
    // Never answers: the BFF gives up at its deadline.
  } else if (path === `/v1/playback/sessions/${PLAYBACK_SESSION}/renew`) {
    answer(response, 200, { data: RENEWAL }, { 'set-cookie': ticketCookie(RENEWED_VALUE) });
  } else if (path === `/v1/playback/sessions/${SIGNED_OUT_SESSION}/renew`) {
    refused(response, 403, IdentityErrorCode.SIGNED_OUT_ELSEWHERE);
  } else if (path === `/v1/playback/sessions/${PLAYBACK_SESSION}/release`) {
    response.writeHead(204).end();
  } else {
    refused(response, 404, ApiErrorCode.NOT_FOUND);
  }
}

const levels = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const;
/** Kept by the spies themselves: Vitest 5 clears `mock.calls` between tests. */
const logged: unknown[][] = [];

beforeAll(async () => {
  for (const level of levels) {
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    vi.spyOn(Logger, level).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }
  identityStandIn = createServer((request, response) => {
    void bodyOf(request).then((body) => {
      const { token } = JSON.parse(body) as { token: string };
      const session = [COOKIE_TOKEN, BEARER_TOKEN].includes(token)
        ? {
            accountId: ACCOUNT,
            deviceId: DEVICE,
            deviceSessionId: DEVICE_SESSION,
            expiresAt: '2026-11-05T10:00:00.000Z',
            profile: PROFILE,
            account: { publicHandle: '@marie', emailVerified: true },
          }
        : null;
      answer(response, 200, { data: { session } });
    });
  });
  streamingStandIn = createServer((request, response) => {
    void bodyOf(request).then((body) => streaming(request, response, body));
  });
  await Promise.all(
    [identityStandIn, streamingStandIn].map(
      (server) => new Promise<void>((resolve) => server.listen(0, resolve)),
    ),
  );
  const urlOf = (server: Server) =>
    `http://localhost:${String((server.address() as AddressInfo).port)}`;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(IDENTITY_URL)
    .useValue(urlOf(identityStandIn))
    .overrideProvider(STREAMING_URL)
    .useValue(urlOf(streamingStandIn))
    .overrideProvider(PLAYBACK_COOKIE_DOMAIN)
    .useValue(COOKIE_DOMAIN)
    .overrideProvider(VIEWER_COUNTRY_HEADER)
    .useValue(COUNTRY_HEADER)
    // An hour ahead, so no deadline falls due under load: search.e2e records why.
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  serveEndpoints(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  for (const server of [identityStandIn, streamingStandIn]) {
    server?.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

beforeEach(() => {
  calls.length = 0;
});

const WEB = { 'x-arthome-surface': Surface.STOREFRONT_WEB };
const OPENING = {
  deviceId: DEVICE,
  profileId: PROFILE.id,
  kind: DisplayState.LIVE,
  capabilities: { drmSystems: ['widevine'] },
};

interface SetCookie {
  readonly name: string;
  readonly value: string;
}

function cookiesOf(response: { cookies: unknown }): Map<string, SetCookie> {
  return new Map((response.cookies as SetCookie[]).map((cookie) => [cookie.name, cookie]));
}

function setCookieLines(response: {
  headers: Record<string, string | string[] | number | undefined>;
}): string[] {
  const lines = response.headers['set-cookie'];
  if (lines === undefined) return [];
  return Array.isArray(lines) ? lines : [String(lines)];
}

/** A browser signed in by cookie, with the CSRF pair `getViewerContext` hands it. */
async function browser(): Promise<{ readonly cookie: string; readonly csrf: string }> {
  const context = await app.inject({
    method: 'GET',
    url: '/v1/viewer-context',
    headers: WEB,
    cookies: { [SESSION_COOKIE]: COOKIE_TOKEN },
  });
  expect(context.statusCode).toBe(200);
  const set = cookiesOf(context);
  const csrf = set.get(CSRF_COOKIE)?.value ?? '';
  const cookie = [
    `${SESSION_COOKIE}=${COOKIE_TOKEN}`,
    `${CSRF_COOKIE}=${csrf}`,
    `${CSRF_SECRET_COOKIE}=${set.get(CSRF_SECRET_COOKIE)?.value ?? ''}`,
  ].join('; ');
  return { cookie, csrf };
}

async function byCookie(url: string, payload?: object) {
  const { cookie, csrf } = await browser();
  return app.inject({
    method: 'POST',
    url,
    headers: { ...WEB, cookie, [CSRF_HEADER]: csrf, [COUNTRY_HEADER]: 'fr' },
    ...(payload !== undefined && { payload }),
  });
}

function byBearer(url: string, payload?: object) {
  return app.inject({
    method: 'POST',
    url,
    headers: { ...WEB, authorization: `Bearer ${BEARER_TOKEN}`, [COUNTRY_HEADER]: 'fr' },
    ...(payload !== undefined && { payload }),
  });
}

describe('openPlayback', () => {
  it('answers the ticket, no-store, with the ticket cookie relayed on the edge’s domain', async () => {
    const response = await byCookie(`/v1/playback/${DATE}/open`, OPENING);

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ data: TICKET });
    expect(setCookieLines(response)).toContain(
      `${ticketCookie(TICKET_VALUE)}; Domain=${COOKIE_DOMAIN}`,
    );
    expect(cookiesOf(response).has('stray')).toBe(false);
  });

  it('calls streaming for the viewer, with the body unchanged, the surface, the country and its deadline', async () => {
    await byCookie(`/v1/playback/${DATE}/open`, OPENING);

    const [call] = calls;
    expect(calls).toHaveLength(1);
    expect(call?.body).toEqual(OPENING);
    expect(call?.claims).toMatchObject({
      aud: audienceOf(Service.STREAMING),
      sub: ACCOUNT,
      did: DEVICE,
      pro: PROFILE.id,
    });
    expect(call?.headers['x-arthome-surface']).toBe(Surface.STOREFRONT_WEB);
    expect(call?.headers['x-arthome-actor-surface']).toBe(Surface.STOREFRONT_WEB);
    expect(call?.headers['x-arthome-viewer-country']).toBe('FR');
    const deadlineMs = Date.parse(String(call?.headers[DEADLINE_HEADER]));
    expect(deadlineMs - clock.nowMs()).toBeGreaterThan(0);
    expect(deadlineMs - clock.nowMs()).toBeLessThanOrEqual(1_000);
  });

  it('relays the concurrent limit with one entry per active session', async () => {
    const response = await byBearer(`/v1/playback/${DATE_FULL}/open`, OPENING);

    expect(response.statusCode).toBe(403);
    // Each entry as the contract declares it: core's params schema gives an entry no field yet.
    expect(response.json()).toMatchObject({
      error: {
        code: WatchDenialReason.CONCURRENT_LIMIT_REACHED,
        params: { allowed: 1, activeSessions: [{}] },
      },
    });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('relays an expired replay', async () => {
    const response = await byBearer(`/v1/playback/${DATE_REPLAY_EXPIRED}/open`, OPENING);

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: { code: WatchDenialReason.REPLAY_EXPIRED } });
  });

  it('answers its own 502 for a refusal the route does not declare', async () => {
    const response = await byBearer(`/v1/playback/${DATE_UNDECLARED}/open`, OPENING);

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { code: ApiErrorCode.UPSTREAM_UNAVAILABLE, params: { service: Service.STREAMING } },
    });
  });

  it('answers its own 504 when streaming stays silent past the budget', async () => {
    // The session lookup keeps a second of slack; streaming's deadline then falls due for real.
    clock.advance(Date.now() + 1_000 - clock.nowMs());
    try {
      const response = await byBearer(`/v1/playback/${DATE_SILENT}/open`, OPENING);

      expect(response.statusCode).toBe(504);
      expect(response.json()).toMatchObject({
        error: { code: ApiErrorCode.UPSTREAM_TIMEOUT, params: { service: Service.STREAMING } },
      });
    } finally {
      clock.advance(Date.now() + 3_600_000 - clock.nowMs());
    }
  }, 10_000);

  it('needs no CSRF token by bearer', async () => {
    const response = await byBearer(`/v1/playback/${DATE}/open`, OPENING);

    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('is refused without the CSRF token before streaming hears of it', async () => {
    const { cookie } = await browser();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/playback/${DATE}/open`,
      headers: { ...WEB, cookie },
      payload: OPENING,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: ApiErrorCode.FORBIDDEN } });
    expect(calls).toEqual([]);
  });

  it('is refused without a session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/playback/${DATE}/open`,
      headers: WEB,
      payload: OPENING,
    });

    expect(response.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe('renewPlaybackTicket', () => {
  it('relays the renewed ticket cookie', async () => {
    const response = await byCookie(`/v1/playback/sessions/${PLAYBACK_SESSION}/renew`);

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ data: RENEWAL });
    expect(setCookieLines(response)).toContain(
      `${ticketCookie(RENEWED_VALUE)}; Domain=${COOKIE_DOMAIN}`,
    );
    expect(calls[0]?.headers['x-arthome-viewer-country']).toBe('FR');
  });

  it('relays a viewer signed out elsewhere', async () => {
    const response = await byBearer(`/v1/playback/sessions/${SIGNED_OUT_SESSION}/renew`);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: IdentityErrorCode.SIGNED_OUT_ELSEWHERE },
    });
  });
});

describe('releasePlayback', () => {
  it('answers streaming’s no content and relays no cookie', async () => {
    const response = await byCookie(`/v1/playback/sessions/${PLAYBACK_SESSION}/release`);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(setCookieLines(response).some((line) => line.startsWith('arthome_playback='))).toBe(
      false,
    );
    expect(calls.map((call) => call.path)).toEqual([
      `/v1/playback/sessions/${PLAYBACK_SESSION}/release`,
    ]);
  });
});

describe('the logs', () => {
  it('hold no cookie value, token or Set-Cookie line from any call above', () => {
    const lines = JSON.stringify(logged);

    expect(lines).toContain('stray');
    for (const secret of [
      TICKET_VALUE,
      RENEWED_VALUE,
      STRAY_VALUE,
      COOKIE_TOKEN,
      BEARER_TOKEN,
      ...tokens,
    ]) {
      expect(lines).not.toContain(secret);
    }
    expect(lines).not.toMatch(/arthome_playback=/);
  });
});
