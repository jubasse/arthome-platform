import type { Logger } from '@nestjs/common';

import { fromEpochMs, type Instant } from '@arthome/core';

import { LIVE_PREFIX, type MediaMtxPath } from './mediamtx-api.js';
import { IngestProtocol, type IngestLifecycleListener } from '../media-ports.js';

/** MediaMTX's source types for the protocols the origin ingests; any other is not a feed. */
const PROTOCOL_OF_SOURCE: Readonly<Record<string, IngestProtocol>> = {
  webRTCSession: IngestProtocol.WHIP,
  srtConn: IngestProtocol.SRT,
};

export function protocolOfSource(path: MediaMtxPath): IngestProtocol | null {
  return path.source === null ? null : (PROTOCOL_OF_SOURCE[path.source.type] ?? null);
}

export function onlineInstantOf(path: MediaMtxPath, readAt: Instant): Instant {
  const ms = path.onlineTime === null ? Number.NaN : Date.parse(path.onlineTime);
  return Number.isNaN(ms) ? readAt : fromEpochMs(ms);
}

/**
 * Turns the origin's path list into the listener's reports by difference with the previous one.
 *   A report the listener failed to take is not remembered, so the next observation repeats it.
 *   A loss is stamped with the instant the list was read, not when it is reported: a publisher
 *   back in between must not look older than its own loss.
 */
export class PathWatcher {
  /** Stream path to the `onlineTime` reported. */
  private readonly reported = new Map<string, Instant>();
  private readonly ignoredSources = new Set<string>();

  public constructor(
    private readonly listener: IngestLifecycleListener,
    private readonly logger: Logger,
  ) {}

  public async observe(paths: ReadonlyMap<string, MediaMtxPath>, readAt: Instant): Promise<void> {
    const live = new Map<string, { protocol: IngestProtocol; at: Instant }>();
    for (const path of paths.values()) {
      if (!path.name.startsWith(LIVE_PREFIX) || !path.online) continue;
      const streamPath = path.name.slice(LIVE_PREFIX.length);
      const protocol = protocolOfSource(path);
      if (protocol === null) {
        if (path.source !== null) this.ignoreOnce(streamPath, path.source.type);
        continue;
      }
      live.set(streamPath, { protocol, at: onlineInstantOf(path, readAt) });
    }

    for (const [streamPath, { protocol, at }] of live) {
      if (this.reported.get(streamPath) === at) continue;
      await this.report(async () => {
        await this.listener.publisherOnline({ streamPath, protocol, at });
        this.reported.set(streamPath, at);
      });
    }
    for (const [streamPath, onlineSince] of [...this.reported]) {
      if (live.has(streamPath)) continue;
      await this.report(async () => {
        await this.listener.publisherOffline({ streamPath, onlineSince, at: readAt });
        this.reported.delete(streamPath);
      });
    }
  }

  private async report(call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (error) {
      this.logger.error(error instanceof Error ? error.stack : String(error));
    }
  }

  private ignoreOnce(streamPath: string, sourceType: string): void {
    const key = `${streamPath} ${sourceType}`;
    if (this.ignoredSources.has(key)) return;
    this.ignoredSources.add(key);
    this.logger.warn(`a live path published by a ${sourceType} source: not a feed, ignored`);
  }
}
