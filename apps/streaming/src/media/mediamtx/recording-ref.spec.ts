import { describe, expect, it } from 'vitest';

import { decodeRecordingRef, encodeRecordingRef } from './recording-ref.js';
import { recordingRefOf } from '../media-ports.js';

describe('the MediaMTX recording reference', () => {
  it('carries the path and the start, opaque and URL-safe', () => {
    const span = { streamPath: 'k7Qe2pLx9vWm', start: '2026-10-11T19:00:00.000Z' };
    const ref = encodeRecordingRef(span);

    expect(ref).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(ref).not.toContain(span.streamPath);
    expect(decodeRecordingRef(ref)).toEqual(span);
  });

  it('decodes nothing it did not write', () => {
    for (const stored of [
      'rec_01a0e700',
      Buffer.from('{"p":"../x","s":"2026-10-11T19:00:00.000Z"}').toString('base64url'),
      Buffer.from('{"p":"sp","s":"yesterday"}').toString('base64url'),
      Buffer.from('not json').toString('base64url'),
    ]) {
      expect(decodeRecordingRef(recordingRefOf(stored))).toBeNull();
    }
  });

  it('refuses to encode a path that is not one segment', () => {
    expect(() =>
      encodeRecordingRef({ streamPath: 'a/b', start: '2026-10-11T19:00:00.000Z' }),
    ).toThrow();
  });
});
