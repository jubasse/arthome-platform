// R0 spike harness (MX2 §6 R0, PM1 §6 R0). Development only; the dev playback key, never a real one.
//
//   node r0.mjs gen <streamPath> <key> [opus|aac]   writes .generated/{encoder.yml,envoy-timed.yaml,envoy-echo.yaml}
//   node r0.mjs token <dateId> <ttlSec> [aud] [prefix]
//   node r0.mjs serve <port> <dateId>                player page + ticket renewal (cookie and body), another origin
//   node r0.mjs play <minutes> <dateId>              headless Chrome on the page, JSON on stdout (R0_PLAYERS)
//   node r0.mjs envoy-times < access.log             Envoy's own time per request and per host, quantiles
//   node r0.mjs probe                                every token source and CORS case on envoy-echo.yaml
//   node r0.mjs probe-edge <dateId>                  CORS on the real edge's answers (envoy-timed.yaml)

import { spawn } from 'node:child_process';
import { createSign, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, request } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPlaybackSigningKey } from '@arthome-platform/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const generated = path.join(here, '.generated');
const [command, ...args] = process.argv.slice(2);

// The query player reads Envoy by address, the cookie player on the page's host: a host-only cookie
// set on `localhost:<page>` reaches `localhost:58888`, never `127.0.0.1:58888`.
const ENVOY = 'http://127.0.0.1:58888';
const ENVOY_BY_COOKIE = 'http://localhost:58888';
const DIRECT = 'http://127.0.0.1:58886';
const PAGE_PORT = Number(process.env.R0_PAGE_PORT ?? 58100);
const PAGE_ORIGIN = `http://localhost:${PAGE_PORT}`;
const STOREFRONT_ORIGIN = 'http://localhost:3000';
const PLAYBACK_COOKIE = 'arthome_playback';
// `envoy-echo.yaml`: Envoy in front of `echo-upstream.mjs` instead of the edge, both on the
// `r0-echo` network, Envoy's listener on 127.0.0.1:58902 (see `probe`).
const ECHO_ENVOY = 'http://127.0.0.1:58902';

function base64Url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString(
    'base64url',
  );
}

function mint(dateId, ttlSec, aud = 'arthome.cdn', prefix = `/watch/${dateId}/`) {
  const { keyId, privateJwk } = readPlaybackSigningKey({ NODE_ENV: 'development' });
  const header = base64Url({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  const claims = base64Url({
    sub: randomUUID(),
    did: randomUUID(),
    dat: dateId,
    sid: randomUUID(),
    qmax: '1080p',
    scope: 'full',
    jti: randomUUID(),
    prefix,
    aud,
    exp: Math.floor(Date.now() / 1000) + Number(ttlSec),
  });
  const signature = createSign('SHA256')
    .update(`${header}.${claims}`)
    .sign({ key: { ...privateJwk }, format: 'jwk', dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${signature.toString('base64url')}`;
}

function gen(streamPath, key, audio = 'opus') {
  fs.mkdirSync(generated, { recursive: true });
  const encoder = [
    'logLevel: info',
    'rtsp: true',
    'rtspTransports: [tcp]',
    'rtmp: false',
    'hls: false',
    'webrtc: false',
    'srt: false',
    'moq: false',
    'paths:',
    '  src:',
    `    runOnInit: /encoder.sh rtsp://127.0.0.1:8554/src ${audio}`,
    '    runOnInitRestart: true',
    '    forward:',
    `      - dest: whip://mediamtx-origin:8889/live/${streamPath}/whip`,
    `        whipBearerToken: ${key}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(generated, 'encoder.yml'), encoder);

  const format = [
    'R0',
    '%START_TIME(%s.%3f)%',
    '%REQ(:METHOD)%',
    // Without its query: the token never lands in a log, stripped or not. No `cookie` either.
    '%PATH(NQ)%',
    '%RESPONSE_CODE%',
    '%RESPONSE_FLAGS%',
    '%COMMON_DURATION(DS_RX_BEG:US_TX_BEG:us)%',
    '%COMMON_DURATION(US_RX_BEG:DS_TX_BEG:us)%',
    '%COMMON_DURATION(US_TX_BEG:US_RX_END:us)%',
    '%COMMON_DURATION(DS_RX_BEG:DS_TX_END:us)%',
    '%REQ(:AUTHORITY)%',
    '%REQ(ORIGIN)%',
  ].join(' ');
  const accessLog = [
    '                access_log:',
    '                  - name: envoy.access_loggers.stdout',
    '                    typed_config:',
    '                      "@type": type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog',
    '                      log_format:',
    `                        text_format_source: { inline_string: "${format}\\n" }`,
  ].join('\n');
  const edge = replaceOnce(
    fs.readFileSync(path.join(here, '../../envoy/edge.yaml'), 'utf8'),
    `exact: ${STOREFRONT_ORIGIN}`,
    `exact: ${PAGE_ORIGIN}`,
  );
  const timed = edge.replace(
    '                stat_prefix: watch\n',
    `                stat_prefix: watch\n${accessLog}\n`,
  );
  if (timed === edge) throw new Error('edge.yaml: no stat_prefix line to hang the access log on');
  const admin = 'admin:\n  address:\n    socket_address: { address: 0.0.0.0, port_value: 9901 }\n';
  fs.writeFileSync(path.join(generated, 'envoy-timed.yaml'), `${admin}${timed}`);

  // The upstream sees what the edge would; the Lua filter hands it the prefix it bound the path with.
  const echo = replaceOnce(
    replaceOnce(
      edge,
      'socket_address: { address: mediamtx-edge, port_value: 8888 }',
      'socket_address: { address: r0-echo, port_value: 8080 }',
    ),
    'handle:respond({ [":status"] = "401" }, "")\n',
    'handle:respond({ [":status"] = "401" }, "")\n' +
      '                            else handle:headers():add("x-r0-prefix", prefix)\n',
  );
  fs.writeFileSync(path.join(generated, 'envoy-echo.yaml'), echo);
}

function replaceOnce(text, from, to) {
  if (text.split(from).length !== 2) throw new Error(`edge.yaml: not exactly one "${from}"`);
  return text.replace(from, to);
}

function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) };
}

function envoyTimes() {
  const lines = fs.readFileSync(0, 'utf8').split('\n');
  const hosts = {};
  const statuses = {};
  const methods = {};
  for (const line of lines) {
    const fields = line.slice(line.indexOf('R0 ')).split(' ');
    if (fields[0] !== 'R0') continue;
    const [, , method, , status, , toUpstream, toDownstream, upstream, total, authority] = fields;
    statuses[status] = (statuses[status] ?? 0) + 1;
    methods[method] = (methods[method] ?? 0) + 1;
    if (status !== '200') continue;
    for (const host of ['all', authority]) {
      hosts[host] ??= { own: [], byDifference: [] };
      hosts[host].own.push((Number(toUpstream) + Number(toDownstream)) / 1000);
      hosts[host].byDifference.push((Number(total) - Number(upstream)) / 1000);
    }
  }
  return {
    statuses,
    methods,
    byHost: Object.fromEntries(
      Object.entries(hosts).map(([host, { own, byDifference }]) => [
        host,
        { ownMs: quantiles(own), downstreamMinusUpstreamMs: quantiles(byDifference) },
      ]),
    ),
  };
}

/** Streaming's format (`playback-format.ts`), on the date's prefix, expiring with the token. */
function ticketCookie(dateId, token, ttlSec) {
  const expires = new Date(Date.now() + ttlSec * 1000).toUTCString();
  return (
    `${PLAYBACK_COOKIE}=${token}; Path=/watch/${dateId}/; Expires=${expires}; ` +
    'Secure; HttpOnly; SameSite=None'
  );
}

function serve(port, dateId) {
  const page = fs.readFileSync(path.join(here, 'player.html'), 'utf8');
  createServer((req, res) => {
    if (req.url.startsWith('/token')) {
      const token = mint(dateId, 120);
      res
        .writeHead(200, {
          'content-type': 'text/plain',
          'set-cookie': ticketCookie(dateId, token, 120),
        })
        .end(token);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  }).listen(Number(port), '127.0.0.1');
}

async function play(minutes, dateId) {
  serve(PAGE_PORT, dateId);
  const profile = fs.mkdtempSync(path.join(generated, 'chrome-'));
  const chrome = spawn(
    'google-chrome',
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const wsUrl = await new Promise((resolve) => {
    chrome.stderr.on('data', (chunk) => {
      const match = /DevTools listening on (ws:\S+)/.exec(chunk.toString());
      if (match) resolve(match[1]);
    });
  });
  const browser = new WebSocket(wsUrl);
  await new Promise((resolve) => browser.addEventListener('open', resolve));
  let nextId = 1;
  const pending = new Map();
  const requests = [];
  const cookieSent = new Set();
  const neverSent = new Set();
  const pageErrors = [];
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      browser.send(JSON.stringify({ id, method, params, sessionId }));
    });
  browser.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) pending.get(message.id)(message.result);
    if (message.method === 'Network.requestWillBeSent') {
      const { request, type, requestId } = message.params;
      requests.push({ method: request.method, url: request.url, type, requestId });
    }
    // Answered from the cache, or cancelled: no request reached Envoy, no cookie to count.
    if (message.method === 'Network.requestServedFromCache')
      neverSent.add(message.params.requestId);
    if (message.method === 'Network.loadingFailed' && message.params.canceled) {
      neverSent.add(message.params.requestId);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params.exceptionDetails.exception?.description ?? 'exception');
    }
    if (message.method === 'Network.requestWillBeSentExtraInfo') {
      const { associatedCookies = [], requestId } = message.params;
      const sent = associatedCookies.some(
        ({ cookie, blockedReasons }) =>
          cookie.name === PLAYBACK_COOKIE && blockedReasons.length === 0,
      );
      if (sent) cookieSent.add(requestId);
    }
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Network.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  const query = new URLSearchParams({
    envoy: ENVOY,
    cookieEnvoy: ENVOY_BY_COOKIE,
    direct: DIRECT,
    dateId,
    players: process.env.R0_PLAYERS ?? 'cookie,query,direct',
  });
  await send('Page.navigate', { url: `${PAGE_ORIGIN}/?${query}` }, sessionId);

  await new Promise((resolve) => setTimeout(resolve, Number(minutes) * 60_000));
  const cookies = await send(
    'Network.getCookies',
    { urls: [`${ENVOY_BY_COOKIE}/watch/${dateId}/`] },
    sessionId,
  );
  const { result } = await send(
    'Runtime.evaluate',
    { expression: 'JSON.stringify(window.r0Report())', returnByValue: true },
    sessionId,
  );
  const refusal = await send(
    'Runtime.evaluate',
    { expression: 'window.r0Refusal()', awaitPromise: true, returnByValue: true },
    sessionId,
  );
  const exited = new Promise((resolve) => chrome.on('exit', resolve));
  chrome.kill();
  await exited;
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });

  const byPlayer = {};
  for (const [player, base] of [
    ['query', ENVOY],
    ['cookie', ENVOY_BY_COOKIE],
  ]) {
    byPlayer[player] = requestKinds(
      requests.filter((r) => r.url.startsWith(base) && !neverSent.has(r.requestId)),
      cookieSent,
    );
  }
  const report = {
    page: JSON.parse(result.value),
    refusalReadByPage: refusal.result.value,
    pageErrors,
    cookiesForEnvoy: cookies.cookies.map(({ name, path, secure, httpOnly, sameSite }) => ({
      name,
      path,
      secure,
      httpOnly,
      sameSite,
    })),
    byPlayer,
    preflights: requests.filter((r) => r.method === 'OPTIONS' || r.type === 'Preflight').length,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

function requestKinds(toEnvoy, cookieSent) {
  const kinds = {};
  for (const r of toEnvoy) {
    const name = new URL(r.url).pathname.split('/').at(-1);
    const kind = new URL(r.url).pathname.includes('-other/')
      ? 'refusal-probe'
      : name.endsWith('.m3u8')
        ? new URL(r.url).searchParams.has('_HLS_msn')
          ? 'blocking-reload'
          : name === 'index.m3u8'
            ? 'multivariant'
            : 'media-playlist'
        : name.includes('_part')
          ? 'part'
          : name.includes('_init')
            ? 'init'
            : 'segment';
    kinds[kind] ??= { requests: 0, withToken: 0, withCookie: 0 };
    kinds[kind].requests += 1;
    if (new URL(r.url).searchParams.has('token')) kinds[kind].withToken += 1;
    if (cookieSent.has(r.requestId)) kinds[kind].withCookie += 1;
  }
  return { requests: toEnvoy.length, kinds };
}

/** The path sent as written: `fetch` would resolve `..` before Envoy sees it. */
function send(base, method, requestPath, headers) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    request({ host: hostname, port, method, path: requestPath, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    })
      .on('error', reject)
      .end();
  });
}

function corsOf(headers) {
  return {
    allowOrigin: headers['access-control-allow-origin'] ?? null,
    allowCredentials: headers['access-control-allow-credentials'] ?? null,
    vary: headers.vary ?? null,
  };
}

/**
 * Every token source against Envoy in front of `echo-upstream.mjs`: what it serves and forwards.
 *   docker network create r0-echo
 *   docker run -d --name r0-echo --network r0-echo -v ./echo-upstream.mjs:/echo.mjs:ro node:22-alpine node /echo.mjs
 *   docker run -d --name r0-envoy-echo --network r0-echo -p 127.0.0.1:58902:8080 \
 *     -v ./.generated/envoy-echo.yaml:/etc/envoy/edge.yaml:ro \
 *     -v ../playback-jwks.json:/etc/envoy/playback-jwks.json:ro <playback-edge image> -c /etc/envoy/edge.yaml
 */
async function probe() {
  const a = 'aaaaaaaa-0000-7000-8000-00000000000a';
  const b = 'bbbbbbbb-0000-7000-8000-00000000000b';
  const segment = `/watch/${a}/seg.mp4`;
  const tokens = {
    a: mint(a, 120),
    b: mint(b, 120),
    expired: mint(a, -60),
    otherAudience: mint(a, 120, 'arthome.api'),
    garbage: 'not.a.jwt',
  };
  const cookie = (name) => `${PLAYBACK_COOKIE}=${tokens[name]}`;
  const cases = [
    ['none', segment, {}],
    ['cookie a', segment, { cookie: cookie('a') }],
    ['cookie a among others', segment, { cookie: `theme=dark; ${cookie('a')}; lang=fr` }],
    ['query a', `${segment}?token=${tokens.a}`, {}],
    ['cookie expired', segment, { cookie: cookie('expired') }],
    ['cookie other audience', segment, { cookie: cookie('otherAudience') }],
    ['cookie b', segment, { cookie: cookie('b') }],
    ['cookie b, ..', `/watch/${b}/../${a}/seg.mp4`, { cookie: cookie('b') }],
    ['cookie b, %2e%2e', `/watch/${b}/%2e%2e/${a}/seg.mp4`, { cookie: cookie('b') }],
    ['cookie b, ..%2F', `/watch/${b}/..%2F${a}/seg.mp4`, { cookie: cookie('b') }],
    ['cookie a + query a', `${segment}?token=${tokens.a}`, { cookie: cookie('a') }],
    ['cookie a + query b', `${segment}?token=${tokens.b}`, { cookie: cookie('a') }],
    ['cookie b + query a', `${segment}?token=${tokens.a}`, { cookie: cookie('b') }],
    ['cookie expired + query a', `${segment}?token=${tokens.a}`, { cookie: cookie('expired') }],
    ['cookie a + query expired', `${segment}?token=${tokens.expired}`, { cookie: cookie('a') }],
    ['cookie garbage + query a', `${segment}?token=${tokens.a}`, { cookie: cookie('garbage') }],
    ['cookie a + query garbage', `${segment}?token=${tokens.garbage}`, { cookie: cookie('a') }],
  ];
  const results = {};
  for (const [name, requestPath, headers] of cases) {
    const allowed = await send(ECHO_ENVOY, 'GET', requestPath, { ...headers, origin: PAGE_ORIGIN });
    const other = await send(ECHO_ENVOY, 'GET', requestPath, {
      ...headers,
      origin: 'http://localhost:3001',
    });
    results[name] = {
      status: allowed.status,
      upstream: allowed.status === 200 ? JSON.parse(allowed.body) : null,
      corsAllowed: corsOf(allowed.headers),
      corsOther: corsOf(other.headers),
    };
  }
  const preflight = (origin) =>
    send(ECHO_ENVOY, 'OPTIONS', segment, {
      origin,
      'access-control-request-method': 'GET',
    });
  const allowedPreflight = await preflight(PAGE_ORIGIN);
  const otherPreflight = await preflight('http://localhost:3001');
  results.preflight = {
    allowed: { status: allowedPreflight.status, headers: allowedPreflight.headers },
    other: { status: otherPreflight.status, headers: otherPreflight.headers },
  };
  return results;
}

/** What the real edge's answers carry through Envoy, by origin. */
async function probeEdge(dateId) {
  const manifest = `/watch/${dateId}/index.m3u8`;
  const results = {};
  for (const [name, origin] of [
    ['allowed', PAGE_ORIGIN],
    ['other', 'http://localhost:3001'],
    ['none', undefined],
  ]) {
    const headers = origin === undefined ? {} : { origin };
    const served = await send(ENVOY, 'GET', manifest, {
      ...headers,
      cookie: `${PLAYBACK_COOKIE}=${mint(dateId, 120)}`,
    });
    const refused = await send(ENVOY, 'GET', manifest, headers);
    results[name] = {
      served: { status: served.status, headers: served.headers, body: served.body.slice(0, 80) },
      refused: { status: refused.status, headers: refused.headers },
    };
  }
  return results;
}

switch (command) {
  case 'gen':
    gen(...args);
    break;
  case 'token':
    process.stdout.write(`${mint(...args)}\n`);
    break;
  case 'serve':
    serve(...args);
    break;
  case 'play':
    await play(...args);
    break;
  case 'probe':
    process.stdout.write(`${JSON.stringify(await probe(), null, 2)}\n`);
    break;
  case 'probe-edge':
    process.stdout.write(`${JSON.stringify(await probeEdge(...args), null, 2)}\n`);
    break;
  case 'envoy-times':
    process.stdout.write(`${JSON.stringify(envoyTimes(), null, 2)}\n`);
    break;
  default:
    console.error('usage: node r0.mjs gen|token|serve|play|envoy-times|probe|probe-edge ...');
    process.exit(2);
}
