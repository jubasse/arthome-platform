import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixedClock, MINUTE_MS } from '@arthome/core';

import {
  AUDIO_WORKER_FAILED_AFTER_MS,
  AUDIO_WORKER_GRACE_MS,
  EdgeRoutes,
  edgePathConfigurationOf,
} from './edge-routes.js';
import type { MediaMtxPath } from './mediamtx-api.js';
import { MediaMtxHttp } from './mediamtx-http.js';
import type { WorkerFailed } from '../media-ports.js';

const NOW = '2026-10-11T19:00:00.000Z';
const ORIGIN_RTSP = 'rtsp://mediamtx-origin:8554';
const ROUTE = { dateId: 'd1', streamPath: 'sp1', generation: 1 };

function opusFeed(online = true): MediaMtxPath {
  return {
    name: 'live/sp1',
    online,
    onlineTime: NOW,
    source: { type: 'webRTCSession', id: 'w1' },
    tracks2: [{ codec: 'H264' }, { codec: 'Opus', codecProps: { channelCount: 2 } }],
    inboundBytes: 0,
  };
}

function aacFeed(): MediaMtxPath {
  return {
    ...opusFeed(),
    source: { type: 'srtConn', id: 's1' },
    tracks2: [
      { codec: 'H264' },
      { codec: 'MPEG-4 Audio', codecProps: { sampleRate: 44_100, channelCount: 1 } },
    ],
  };
}

describe('the edge path configuration', () => {
  it('pulls an AAC feed from the origin as it is, its tracks declared', () => {
    expect(edgePathConfigurationOf(aacFeed(), ROUTE, ORIGIN_RTSP)).toEqual({
      source: 'rtsp://mediamtx-origin:8554/live/sp1',
      alwaysAvailable: true,
      alwaysAvailableTracks: [
        { codec: 'H264' },
        { codec: 'MPEG4Audio', sampleRate: 44_100, channelCount: 1 },
      ],
    });
  });

  it('runs the audio worker for an Opus feed, its generation in the command', () => {
    expect(edgePathConfigurationOf(opusFeed(), { ...ROUTE, generation: 3 }, ORIGIN_RTSP)).toEqual({
      source: 'publisher',
      alwaysAvailable: true,
      alwaysAvailableTracks: [
        { codec: 'H264' },
        { codec: 'MPEG4Audio', sampleRate: 48_000, channelCount: 2 },
      ],
      runOnInit: '/audio-worker.sh rtsp://mediamtx-origin:8554/live/sp1 watch/d1 3',
      runOnInitRestart: false,
    });
  });

  it('routes nothing but H.264 with AAC or Opus', () => {
    const h265 = { ...aacFeed(), tracks2: [{ codec: 'H265' }, { codec: 'Opus' }] };
    expect(edgePathConfigurationOf(h265, ROUTE, ORIGIN_RTSP)).toBeNull();
  });
});

describe('EdgeRoutes', () => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let edgePaths: MediaMtxPath[];
  let clock: FixedClock;
  let routes: EdgeRoutes;
  const failures: WorkerFailed[] = [];
  const listener = {
    publisherOnline: () => Promise.resolve(),
    publisherOffline: () => Promise.resolve(),
    workerFailed: (event: WorkerFailed) => {
      failures.push(event);
      return Promise.resolve();
    },
  };

  function edgePath(online: boolean): MediaMtxPath {
    return { ...opusFeed(online), name: 'watch/d1', source: null };
  }

  function writes(): string[] {
    return calls
      .filter(({ method }) => method !== 'GET')
      .map(({ method, path }) => `${method} ${path}`);
  }

  function tick(feed: MediaMtxPath | null): Promise<void> {
    return routes.reconcile(new Map(feed === null ? [] : [[feed.name, feed]]), listener);
  }

  beforeEach(() => {
    calls.length = 0;
    failures.length = 0;
    edgePaths = [];
    clock = new FixedClock(NOW);
    routes = new EdgeRoutes(
      new MediaMtxHttp('the edge', 'http://127.0.0.1:59995'),
      ORIGIN_RTSP,
      clock,
      new Logger('test'),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL, init: RequestInit) => {
        const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ method: init.method ?? 'GET', path: url.pathname, body });
        if (url.pathname === '/v3/paths/list') {
          return Promise.resolve(Response.json({ pageCount: 1, items: edgePaths }));
        }
        return Promise.resolve(Response.json({ status: 'ok' }));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls nothing before a date is signed', async () => {
    await tick(opusFeed());
    expect(calls).toEqual([]);
  });

  it('writes a signed date path once its feed is online, and only when it changes', async () => {
    routes.remember('d1', 'sp1');
    await tick(opusFeed(false));
    expect(writes()).toEqual([]);

    await tick(opusFeed());
    edgePaths = [edgePath(true)];
    await tick(opusFeed());
    expect(writes()).toEqual(['POST /v3/config/paths/replace/watch/d1']);

    await tick(aacFeed());
    expect(writes()).toHaveLength(2);
    expect(calls.at(-1)?.body).toMatchObject({ source: 'rtsp://mediamtx-origin:8554/live/sp1' });
  });

  it('keeps the worker through a cut within its grace, restarts it after', async () => {
    routes.remember('d1', 'sp1');
    await tick(opusFeed());
    edgePaths = [edgePath(true)];

    await tick(opusFeed(false));
    clock.advance(AUDIO_WORKER_GRACE_MS - 1_000);
    await tick(opusFeed());
    expect(writes()).toHaveLength(1);

    await tick(opusFeed(false));
    clock.advance(AUDIO_WORKER_GRACE_MS);
    await tick(opusFeed());
    expect(writes()).toHaveLength(2);
    expect(calls.at(-1)?.body).toMatchObject({ runOnInit: expect.stringMatching(/ 2$/) as string });
  });

  it('reports the worker failed once when the edge stays offline with the feed online', async () => {
    routes.remember('d1', 'sp1');
    await tick(opusFeed());
    edgePaths = [edgePath(false)];

    await tick(opusFeed());
    clock.advance(AUDIO_WORKER_FAILED_AFTER_MS);
    await tick(opusFeed());
    await tick(opusFeed());

    expect(failures).toEqual([{ streamPath: 'sp1', attempts: 3, final: true, at: clock.now() }]);
    expect(writes()).toHaveLength(1);
  });

  it('removes a date path ten minutes after its last signature', async () => {
    routes.remember('d1', 'sp1');
    await tick(opusFeed());
    clock.advance(10 * MINUTE_MS + 1);

    await tick(opusFeed());

    expect(writes()).toEqual([
      'POST /v3/config/paths/replace/watch/d1',
      'DELETE /v3/config/paths/delete/watch/d1',
    ]);
  });
});
