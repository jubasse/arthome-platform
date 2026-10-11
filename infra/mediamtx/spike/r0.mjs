// R0 spike harness (MX2 §6 R0). Development only; the dev playback key, never a real one.
//
//   node r0.mjs gen <streamPath> <key> [opus|aac]   writes .generated/{encoder.yml,envoy-timed.yaml}
//   node r0.mjs token <dateId> <ttlSec> [aud] [prefix]
//   node r0.mjs serve <port> <dateId>                player page + token renewal, another origin
//   node r0.mjs play <minutes> <dateId>              headless Chrome on the page, JSON on stdout
//   node r0.mjs envoy-times < access.log             Envoy's own time per request, quantiles

import { spawn } from 'node:child_process';
import { createSign, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPlaybackSigningKey } from '@arthome-platform/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const generated = path.join(here, '.generated');
const [command, ...args] = process.argv.slice(2);

const ENVOY = 'http://127.0.0.1:58888';
const DIRECT = 'http://127.0.0.1:58886';

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
    '%REQ(:PATH)%',
    '%RESPONSE_CODE%',
    '%RESPONSE_FLAGS%',
    '%COMMON_DURATION(DS_RX_BEG:US_TX_BEG:us)%',
    '%COMMON_DURATION(US_RX_BEG:DS_TX_BEG:us)%',
    '%COMMON_DURATION(US_TX_BEG:US_RX_END:us)%',
    '%COMMON_DURATION(DS_RX_BEG:DS_TX_END:us)%',
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
  const edge = fs.readFileSync(path.join(here, '../../envoy/edge.yaml'), 'utf8');
  const timed = edge.replace(
    '                stat_prefix: watch\n',
    `                stat_prefix: watch\n${accessLog}\n`,
  );
  if (timed === edge) throw new Error('edge.yaml: no stat_prefix line to hang the access log on');
  const admin = 'admin:\n  address:\n    socket_address: { address: 0.0.0.0, port_value: 9901 }\n';
  fs.writeFileSync(path.join(generated, 'envoy-timed.yaml'), `${admin}${timed}`);
}

function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) };
}

function envoyTimes() {
  const lines = fs.readFileSync(0, 'utf8').split('\n');
  const own = [];
  const ownByDifference = [];
  const statuses = {};
  const methods = {};
  let tokenUpstream = 0;
  for (const line of lines) {
    const fields = line.slice(line.indexOf('R0 ')).split(' ');
    if (fields[0] !== 'R0') continue;
    const [, , method, requestPath, status, , toUpstream, toDownstream, upstream, total] = fields;
    statuses[status] = (statuses[status] ?? 0) + 1;
    methods[method] = (methods[method] ?? 0) + 1;
    if (status === '200' && requestPath.includes('token=')) tokenUpstream += 1;
    if (status !== '200') continue;
    own.push((Number(toUpstream) + Number(toDownstream)) / 1000);
    ownByDifference.push((Number(total) - Number(upstream)) / 1000);
  }
  return {
    statuses,
    methods,
    forwardedWithToken: tokenUpstream,
    ownMs: quantiles(own),
    downstreamMinusUpstreamMs: quantiles(ownByDifference),
  };
}

function serve(port, dateId) {
  const page = fs.readFileSync(path.join(here, 'player.html'), 'utf8');
  createServer((req, res) => {
    if (req.url.startsWith('/token')) {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(mint(dateId, 120));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  }).listen(Number(port), '127.0.0.1');
}

async function play(minutes, dateId) {
  const pagePort = Number(process.env.R0_PAGE_PORT ?? 58100);
  serve(pagePort, dateId);
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
      const { request, type } = message.params;
      requests.push({ method: request.method, url: request.url, type });
    }
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Network.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  const query = new URLSearchParams({ envoy: ENVOY, direct: DIRECT, dateId });
  await send('Page.navigate', { url: `http://127.0.0.1:${pagePort}/?${query}` }, sessionId);

  await new Promise((resolve) => setTimeout(resolve, Number(minutes) * 60_000));
  const { result } = await send(
    'Runtime.evaluate',
    { expression: 'JSON.stringify(window.r0Report())', returnByValue: true },
    sessionId,
  );
  const exited = new Promise((resolve) => chrome.on('exit', resolve));
  chrome.kill();
  await exited;
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });

  const toEnvoy = requests.filter((r) => r.url.startsWith(ENVOY));
  const kinds = {};
  for (const r of toEnvoy) {
    const name = new URL(r.url).pathname.split('/').at(-1);
    const kind = name.endsWith('.m3u8')
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
    kinds[kind] ??= { requests: 0, withToken: 0 };
    kinds[kind].requests += 1;
    if (new URL(r.url).searchParams.has('token')) kinds[kind].withToken += 1;
  }
  const report = {
    page: JSON.parse(result.value),
    envoyRequests: toEnvoy.length,
    envoyByKind: kinds,
    preflights: requests.filter((r) => r.method === 'OPTIONS' || r.type === 'Preflight').length,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
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
  case 'envoy-times':
    process.stdout.write(`${JSON.stringify(envoyTimes(), null, 2)}\n`);
    break;
  default:
    console.error('usage: node r0.mjs gen|token|serve|play|envoy-times ...');
    process.exit(2);
}
