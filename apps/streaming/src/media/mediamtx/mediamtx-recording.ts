import type { Clock } from '@arthome/core';

import { livePathOf } from './mediamtx-api.js';
import type { MediaMtxHttp } from './mediamtx-http.js';
import { decodeRecordingRef, encodeRecordingRef, type RecordingSpan } from './recording-ref.js';
import {
  RecordingNotFound,
  type RecordingCapabilities,
  type RecordingProvider,
  type RecordingRef,
  type RecordingStatus,
} from '../media-ports.js';

export const MEDIAMTX_RECORDING_CAPABILITIES: RecordingCapabilities = {
  recording: true,
  masterAtIngest: true,
};

/**
 * A segment can start before the instant the recording was asked by the skew between this host's
 *   clock and the media server's; a stream path is one run's, so nothing else records under it.
 */
const SEGMENT_START_SKEW_MS = 5_000;

interface ListedSpan {
  readonly start: string;
  /** Seconds. */
  readonly duration: number;
}

interface Recordings {
  readonly segments: readonly { readonly start: string }[];
}

/**
 * The master stream recorded at the origin, where it is ingested (`streaming.md` §4): a path's own
 *   configuration turns `record` on and off, which MediaMTX hot-reloads without cutting the
 *   publisher (R0). Only the Control API and the playback server's `/list` are called (R14).
 */
export class MediaMtxRecording implements RecordingProvider {
  public readonly recordingCapabilities = MEDIAMTX_RECORDING_CAPABILITIES;

  public constructor(
    private readonly originApi: MediaMtxHttp,
    private readonly originPlayback: MediaMtxHttp,
    private readonly clock: Clock,
  ) {}

  public async start(streamPath: string): Promise<RecordingRef> {
    const ref = encodeRecordingRef({ streamPath, start: this.clock.now() });
    const name = livePathOf(streamPath);
    const patched = await this.originApi.command({
      operation: 'recording start',
      method: 'PATCH',
      path: `/v3/config/paths/patch/${name}`,
      body: { record: true },
    });
    if (!patched) {
      await this.originApi.command({
        operation: 'recording start',
        method: 'POST',
        path: `/v3/config/paths/add/${name}`,
        body: { record: true },
      });
    }
    return ref;
  }

  /** Stopping what records no more is not an error. */
  public async stop(ref: RecordingRef): Promise<void> {
    const { streamPath } = this.spanOf(ref);
    await this.originApi.command({
      operation: 'recording stop',
      method: 'PATCH',
      path: `/v3/config/paths/patch/${livePathOf(streamPath)}`,
      body: { record: false },
    });
  }

  public async status(ref: RecordingRef): Promise<RecordingStatus> {
    const { streamPath, start } = this.spanOf(ref);
    const name = livePathOf(streamPath);
    // In parallel, within the domain's call timeout. While recording, the list may fail: the first
    // segment is not on disk yet.
    const [configuration, listed] = await Promise.allSettled([
      this.originApi.json<{ record: boolean }>({
        operation: 'recording status',
        path: `/v3/config/paths/get/${name}`,
      }),
      this.originPlayback.json<readonly ListedSpan[]>({
        operation: 'recording list',
        path: '/list',
        query: { path: name, start },
      }),
    ]);
    if (configuration.status === 'rejected') throw configuration.reason;
    if (configuration.value?.record === true) return { ready: false, durationSec: null };
    if (listed.status === 'rejected') throw listed.reason;
    const spans = listed.value;
    if (spans === null || spans.length === 0) throw new RecordingNotFound();
    const seconds = spans.reduce((sum, span) => sum + span.duration, 0);
    return { ready: true, durationSec: Math.round(seconds) };
  }

  /** The segments first, then the path's own configuration: a retry finds what is left. */
  public async delete(ref: RecordingRef): Promise<void> {
    const { streamPath, start } = this.spanOf(ref);
    const name = livePathOf(streamPath);
    const recordings = await this.originApi.json<Recordings>({
      operation: 'recording segments',
      path: `/v3/recordings/get/${name}`,
    });
    const from = Date.parse(start) - SEGMENT_START_SKEW_MS;
    for (const segment of recordings?.segments ?? []) {
      if (Date.parse(segment.start) < from) continue;
      await this.originApi.command({
        operation: 'recording segment delete',
        method: 'DELETE',
        path: '/v3/recordings/segments/delete',
        query: { path: name, start: segment.start },
      });
    }
    await this.originApi.command({
      operation: 'recording configuration delete',
      method: 'DELETE',
      path: `/v3/config/paths/delete/${name}`,
    });
  }

  private spanOf(ref: RecordingRef): RecordingSpan {
    const span = decodeRecordingRef(ref);
    if (span === null) throw new RecordingNotFound();
    return span;
  }
}
