import { z } from 'zod';

import { recordingRefOf, type RecordingRef } from '../media-ports.js';

export interface RecordingSpan {
  readonly streamPath: string;
  /** RFC 3339, the instant the recording was asked: the playback server lists from it. */
  readonly start: string;
}

const STREAM_PATH = /^[A-Za-z0-9_-]+$/;

const spanSchema = z.object({
  p: z.string().regex(STREAM_PATH),
  s: z.iso.datetime({ offset: true }),
});

export function encodeRecordingRef({ streamPath, start }: RecordingSpan): RecordingRef {
  if (!STREAM_PATH.test(streamPath)) throw new Error('a stream path must be URL-safe');
  return recordingRefOf(
    Buffer.from(JSON.stringify({ p: streamPath, s: start })).toString('base64url'),
  );
}

/** Null for a reference this provider did not write. */
export function decodeRecordingRef(ref: RecordingRef): RecordingSpan | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = spanSchema.safeParse(decoded);
  return parsed.success ? { streamPath: parsed.data.p, start: parsed.data.s } : null;
}
