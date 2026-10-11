import { readPlaybackSigningKey } from '@arthome-platform/config';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FixedClock, toEpochMs, type Instant } from '@arthome/core';

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

/** `RunIngestListener`'s presence rules, one row per path; each report takes `takesMs` of the clock. */
class RunPresence {
  private readonly rows = new Map<
    string,
    { onlineSince: Instant | null; lostAt: Instant | null }
  >();

  public constructor(
    private readonly clock: FixedClock,
    private readonly takesMs: number,
  ) {}

  public onlineSinceOf(streamPath: string): Instant | null {
    return this.rows.get(streamPath)?.onlineSince ?? null;
  }

  public readonly listener = {
    publisherOnline: ({ streamPath, at }: PublisherOnline): Promise<void> => {
      this.clock.advance(this.takesMs);
      const row = this.rows.get(streamPath) ?? { onlineSince: null, lostAt: null };
      if (row.lostAt === null || toEpochMs(row.lostAt) <= toEpochMs(at)) {
        this.rows.set(streamPath, { ...row, onlineSince: at });
      }
      return Promise.resolve();
    },
    publisherOffline: ({ streamPath, onlineSince, at }: PublisherOffline): Promise<void> => {
      this.clock.advance(this.takesMs);
      if (this.rows.get(streamPath)?.onlineSince === onlineSince) {
        this.rows.set(streamPath, { onlineSince: null, lostAt: at });
      }
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
    const watcher = new PathWatcher(reports.listener, silent);
    const paths = new Map([
      livePath('sp1'),
      livePath('sp2', { source: { type: 'srtConn', id: 'conn-2' } }),
    ]);

    await watcher.observe(paths, NOW);
    await watcher.observe(paths, NOW);

    expect(reports.online).toEqual([
      { streamPath: 'sp1', protocol: IngestProtocol.WHIP, at: '2026-10-11T18:59:58.123Z' },
      { streamPath: 'sp2', protocol: IngestProtocol.SRT, at: '2026-10-11T18:59:58.123Z' },
    ]);
  });

  it('reports a feed offline at the read, with the onset it ends, once gone or not online', async () => {
    const reports = new Reports();
    const watcher = new PathWatcher(reports.listener, silent);
    await watcher.observe(new Map([livePath('sp1'), livePath('sp2')]), NOW);

    await watcher.observe(new Map([livePath('sp2', { online: false })]), NOW);
    await watcher.observe(new Map(), NOW);

    expect(reports.offline).toEqual([
      { streamPath: 'sp1', onlineSince: '2026-10-11T18:59:58.123Z', at: NOW },
      { streamPath: 'sp2', onlineSince: '2026-10-11T18:59:58.123Z', at: NOW },
    ]);
  });

  it('reports a publisher back between two reads by its new onlineTime', async () => {
    const reports = new Reports();
    const watcher = new PathWatcher(reports.listener, silent);
    await watcher.observe(new Map([livePath('sp1')]), NOW);

    await watcher.observe(
      new Map([livePath('sp1', { onlineTime: '2026-10-11T18:59:59.500Z' })]),
      NOW,
    );

    expect(reports.online.map(({ at }) => at)).toEqual([
      '2026-10-11T18:59:58.123Z',
      '2026-10-11T18:59:59.500Z',
    ]);
    expect(reports.offline).toEqual([]);
  });

  it('ignores another source type, and paths outside live/', async () => {
    const reports = new Reports();
    const watcher = new PathWatcher(reports.listener, silent);

    await watcher.observe(
      new Map([
        livePath('sp1', { source: { type: 'rtspSession', id: 'r' } }),
        ['watch/d1', { ...livePath('d1')[1], name: 'watch/d1' }],
      ]),
      NOW,
    );

    expect(reports.online).toEqual([]);
  });

  it('repeats a report the listener failed to take', async () => {
    const reports = new Reports();
    const watcher = new PathWatcher(reports.listener, silent);
    reports.failNext = true;

    await watcher.observe(new Map([livePath('sp1')]), NOW);
    await watcher.observe(new Map([livePath('sp1')]), NOW);

    expect(reports.online).toHaveLength(1);
  });
});

function providerAt(clock: FixedClock, watchEveryMs = 100): MediaMtxStreamingProvider {
  return new MediaMtxStreamingProvider({
    env: readMediaMtxEnv({ ...MEDIAMTX_SPEC_ENV, MEDIAMTX_WATCH_EVERY_MS: String(watchEveryMs) }),
    signingKey: readPlaybackSigningKey({ NODE_ENV: 'test' }),
    clock,
  });
}

/** Each origin read answers the next list, then the last one again. */
function stubOriginReads(reads: readonly (readonly MediaMtxPath[])[]): void {
  let next = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: URL) => {
      if (url.pathname !== '/v3/paths/list' || url.port !== '59997') {
        return Promise.resolve(Response.json({ pageCount: 1, items: [] }));
      }
      const items = reads[Math.min(next, reads.length - 1)];
      next += 1;
      return Promise.resolve(Response.json({ pageCount: 1, items }));
    }),
  );
}

describe('the watch loop', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stamps a loss at the read, so a publisher back while the tick reports is not refused', async () => {
    const back = '2026-10-11T19:00:00.700Z';
    stubOriginReads([
      [livePath('sp1')[1]],
      [livePath('sp2', { onlineTime: '2026-10-11T19:00:00.400Z' })[1]],
      [livePath('sp1', { onlineTime: back })[1], livePath('sp2')[1]],
    ]);
    const clock = new FixedClock(NOW);
    const presence = new RunPresence(clock, 500);
    const provider = providerAt(clock);

    provider.attachIngestHooks({
      authorizer: { authorize: () => Promise.resolve({ accepted: true }) },
      listener: presence.listener,
    });
    try {
      await vi.waitFor(() => {
        expect(presence.onlineSinceOf('sp1')).toBe(back);
      });
    } finally {
      await provider.beforeApplicationShutdown();
    }
  });

  it('stops as soon as the tick in flight ends, without one more period', async () => {
    let release = (): void => undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => {
            resolve(Response.json({ pageCount: 1, items: [] }));
          };
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const provider = providerAt(new FixedClock(NOW), 10_000);
    provider.attachIngestHooks({
      authorizer: { authorize: () => Promise.resolve({ accepted: true }) },
      listener: new Reports().listener,
    });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce();
    });

    const stopped = provider.beforeApplicationShutdown();
    release();
    const startedMs = performance.now();
    await stopped;

    expect(performance.now() - startedMs).toBeLessThan(1_000);
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
    const provider = providerAt(new FixedClock(NOW));

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
