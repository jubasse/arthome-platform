import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixedClock } from '@arthome/core';

import type { MediaMtxPath } from './mediamtx-api.js';
import { MediaMtxHttp } from './mediamtx-http.js';
import { ByteRates, MediaMtxMetrics, codecsOf, samplesOf } from './mediamtx-metrics.js';
import { IngestProtocol } from '../media-ports.js';

const NOW = '2026-10-11T19:00:00.000Z';
const NOW_MS = Date.parse(NOW);

const METRICS = [
  '# HELP webrtc_sessions_inbound_rtp_packets_jitter jitter',
  'webrtc_sessions_inbound_rtp_packets_jitter{id="w1",path="live/sp1",remoteAddr="172.20.0.5:49496",state="publish"} 361.5',
  'webrtc_sessions_inbound_rtp_packets_jitter{id="w2",path="live/sp1",remoteAddr="172.20.0.9:1",state="read"} 9000',
  'webrtc_sessions_inbound_rtp_packets_lost{id="w1",path="live/sp1",remoteAddr="172.20.0.5:49496",state="publish"} 3',
  'paths_inbound_bytes{name="live/sp1",state="ready"} 126000',
].join('\n');

function feed(overrides: Partial<MediaMtxPath> = {}): MediaMtxPath {
  return {
    name: 'live/sp1',
    online: true,
    onlineTime: NOW,
    source: { type: 'webRTCSession', id: 'w1' },
    tracks2: [{ codec: 'H264' }, { codec: 'Opus', codecProps: { channelCount: 2 } }],
    inboundBytes: 126_000,
    ...overrides,
  };
}

let path: MediaMtxPath | null;
const scraped = vi.fn();

beforeEach(() => {
  path = feed();
  scraped.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: URL) => {
      if (url.pathname === '/metrics') {
        scraped();
        return Promise.resolve(new Response(METRICS));
      }
      if (url.pathname === '/v3/paths/get/live/sp1' && path !== null) {
        return Promise.resolve(Response.json(path));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function metricsAt(clock: FixedClock, byteRates = new ByteRates()): MediaMtxMetrics {
  return new MediaMtxMetrics(
    new MediaMtxHttp('the origin', 'http://127.0.0.1:59997'),
    new MediaMtxHttp('the origin metrics', 'http://127.0.0.1:59998'),
    clock,
    byteRates,
    0,
  );
}

describe('MediaMTX metrics', () => {
  it('samples nothing while the feed is offline or absent', async () => {
    const metrics = metricsAt(new FixedClock(NOW));
    path = feed({ online: false });
    await expect(metrics.sample('sp1')).resolves.toBeNull();
    path = null;
    await expect(metrics.sample('sp1')).resolves.toBeNull();
  });

  it('measures a WHIP feed: codecs, rate over the last two readings, jitter in ms, loss', async () => {
    const clock = new FixedClock(NOW);
    const byteRates = new ByteRates();
    byteRates.record('sp1', 1_000, NOW_MS - 1_000);

    await expect(metricsAt(clock, byteRates).sample('sp1')).resolves.toEqual({
      measuredAt: NOW,
      protocol: IngestProtocol.WHIP,
      videoCodec: 'h264',
      audioCodec: 'opus',
      ingestUpKbps: 1_000,
      jitterMs: 5.2,
      lostPackets: 3,
    });
  });

  it('leaves jitter and loss absent on SRT, and does not scrape for them', async () => {
    path = feed({
      source: { type: 'srtConn', id: 's1' },
      tracks2: [{ codec: 'H264' }, { codec: 'MPEG-4 Audio' }],
    });
    const byteRates = new ByteRates();
    byteRates.record('sp1', 1_000, NOW_MS - 1_000);

    const sample = await metricsAt(new FixedClock(NOW), byteRates).sample('sp1');

    expect(sample).toEqual({
      measuredAt: NOW,
      protocol: IngestProtocol.SRT,
      videoCodec: 'h264',
      audioCodec: 'aac',
      ingestUpKbps: 1_000,
    });
    expect(scraped).not.toHaveBeenCalled();
  });

  it('reads the counter a second time when it holds no earlier reading', async () => {
    const clock = new FixedClock(NOW);
    const metrics = metricsAt(clock);
    const fetched = vi.mocked(fetch);
    fetched
      .mockImplementationOnce(() => Promise.resolve(Response.json(feed({ inboundBytes: 1_000 }))))
      .mockImplementationOnce(() => {
        clock.advance(1_000);
        return Promise.resolve(Response.json(feed()));
      });

    const sample = await metrics.sample('sp1');

    expect(sample?.ingestUpKbps).toBe(1_000);
  });

  it('names an unknown codec raw, lowercased', () => {
    expect(codecsOf(feed({ tracks2: [{ codec: 'H265' }, { codec: 'AC3' }] }))).toEqual({
      videoCodec: 'h265',
      audioCodec: 'ac3',
    });
    expect(codecsOf(feed({ tracks2: [{ codec: 'H264' }] }))).toBeNull();
  });

  it('reads one metric line by line, labels and value', () => {
    expect(
      samplesOf(METRICS, 'webrtc_sessions_inbound_rtp_packets_lost').map(({ labels, value }) => [
        labels.get('path'),
        labels.get('state'),
        value,
      ]),
    ).toEqual([['live/sp1', 'publish', 3]]);
  });
});
