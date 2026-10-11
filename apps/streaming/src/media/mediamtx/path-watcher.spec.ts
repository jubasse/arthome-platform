import { readPlaybackSigningKey } from '@arthome-platform/config';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FixedClock } from '@arthome/core';

import type { MediaMtxPath } from './mediamtx-api.js';
import { MediaMtxStreamingProvider } from './mediamtx-streaming-provider.js';
import { PathWatcher } from './path-watcher.js';
import { IngestProtocol, type PublisherOffline, type PublisherOnline } from '../media-ports.js';
import { readMediaMtxEnv } from './mediamtx-env.js';
import { MEDIAMTX_SPEC_ENV } from './mediamtx-spec-env.js';

const NOW = '2026-10-11T19:00:00.000Z';
const ONLINE_AT = '2026-10-11T18:59:58.123456789Z';

function livePath(
  streamPath: string,
  overrides: Partial<MediaMtxPath> = {},
): [string, MediaMtxPath] {
  const name = `live/${streamPath}`;
  return [
    name,
    {
      name,
      online: true,
      onlineTime: ONLINE_AT,
      source: { type: 'webRTCSession', id: 'session-1' },
      tracks2: [{ codec: 'H264' }, { codec: 'Opus' }],
      inboundBytes: 0,
      ...overrides,
    },
  ];
}

class Reports {
  public readonly online: PublisherOnline[] = [];
  public readonly offline: PublisherOffline[] = [];
  public failNext = false;

  public readonly listener = {
    publisherOnline: (event: PublisherOnline): Promise<void> => {
      if (this.failNext) {
        this.failNext = false;
        return Promise.reject(new Error('the database is away'));
      }
      this.online.push(event);
      return Promise.resolve();
    },
    publisherOffline: (event: PublisherOffline): Promise<void> => {
      this.offline.push(event);
      return Promise.resolve();
    },
    workerFailed: (): Promise<void> => Promise.resolve(),
  };
}

const silent = new Logger('test');
vi.spyOn(silent, 'warn').mockImplementation(() => undefined);
vi.spyOn(silent, 'error').mockImplementation(() => undefined);

describe('PathWatcher', () => {
  it('reports a feed online once, at its onlineTime, with the protocol of its source', async () => {
    const reports = new Reports();
    const watcher = new PathWatcher(reports.listener, new FixedClock(NOW), silent);
    const paths = new Map([
      livePath('sp1'),
      livePath('sp2', { source: { type: 'srtConn', id: 'conn-2' } }),
    ]);

    await watcher.observe(paths);
    await watcher.observe(paths);

    expect(reports.online).toEqual([
      { streamPath: 'sp1', protocol: IngestProtocol.WHIP, at: '2026-10-11T18:59:58.123Z' },
      { streamPath: 'sp2', protocol: IngestProtocol.SRT, at: '2026-10-11T18:59:58.123Z' },
    ]);
  });

  it('reports a feed offline at the clock once it is gone or not online', async () => {
    const reports = new Reports();
    const watcher = new PathWatcher(reports.listener, new FixedClock(NOW), silent);
    await watcher.observe(new Map([livePath('sp1'), livePath('sp2')]));

    await watcher.observe(new Map([livePath('sp2', { online: false })]));
    await watcher.observe(new Map());

    expect(reports.offline).toEqual([
      { streamPath: 'sp1', at: NOW },
      { streamPath: 'sp2', at: NOW },
    ]);
  });

  it('reports a publisher back between two reads by its new onlineTime', async () => {
    const reports = new Reports();
    const watcher = new PathWatcher(reports.listener, new FixedClock(NOW), silent);
    await watcher.observe(new Map([livePath('sp1')]));

    await watcher.observe(new Map([livePath('sp1', { onlineTime: '2026-10-11T18:59:59.500Z' })]));

    expect(reports.online.map(({ at }) => at)).toEqual([
      '2026-10-11T18:59:58.123Z',
      '2026-10-11T18:59:59.500Z',
    ]);
    expect(reports.offline).toEqual([]);
  });

  it('ignores another source type, and paths outside live/', async () => {
    const reports = new Reports();
    const watcher = new PathWatcher(reports.listener, new FixedClock(NOW), silent);

    await watcher.observe(
      new Map([
        livePath('sp1', { source: { type: 'rtspSession', id: 'r' } }),
        ['watch/d1', { ...livePath('d1')[1], name: 'watch/d1' }],
      ]),
    );

    expect(reports.online).toEqual([]);
  });

  it('repeats a report the listener failed to take', async () => {
    const reports = new Reports();
    const watcher = new PathWatcher(reports.listener, new FixedClock(NOW), silent);
    reports.failNext = true;

    await watcher.observe(new Map([livePath('sp1')]));
    await watcher.observe(new Map([livePath('sp1')]));

    expect(reports.online).toHaveLength(1);
  });
});

describe('the watch loop', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits nothing while the origin is unreachable: never "every feed offline"', async () => {
    let reachable = true;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL) => {
        if (!reachable) return Promise.reject(new TypeError('fetch failed'));
        const items =
          url.pathname === '/v3/paths/list' && url.port === '59997' ? [livePath('sp1')[1]] : [];
        return Promise.resolve(Response.json({ pageCount: 1, items }));
      }),
    );
    const reports = new Reports();
    const provider = new MediaMtxStreamingProvider({
      env: readMediaMtxEnv({ ...MEDIAMTX_SPEC_ENV, MEDIAMTX_WATCH_EVERY_MS: '100' }),
      signingKey: readPlaybackSigningKey({ NODE_ENV: 'test' }),
      clock: new FixedClock(NOW),
    });

    provider.attachIngestHooks({
      authorizer: { authorize: () => Promise.resolve({ accepted: true }) },
      listener: reports.listener,
    });
    await vi.waitFor(() => {
      expect(reports.online).toHaveLength(1);
    });
    reachable = false;
    await new Promise((resolve) => setTimeout(resolve, 350));
    await provider.beforeApplicationShutdown();

    expect(reports.offline).toEqual([]);
  });
});
