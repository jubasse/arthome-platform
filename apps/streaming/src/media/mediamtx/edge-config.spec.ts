import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PLAYBACK_COOKIE } from '../media-ports.js';

const edge = readFileSync(new URL('../../../../../infra/envoy/edge.yaml', import.meta.url), 'utf8');

/** The items of the YAML list under `key:`, one `- ` line each, as written. */
function listUnder(key: string): string[] {
  const lines = edge.split('\n');
  const at = lines.findIndex((line) => line.trim() === `${key}:`);
  if (at === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s+- (.+)$/.exec(line)?.[1];
    if (item === undefined) break;
    items.push(item.trim());
  }
  return items;
}

describe('the playback edge configuration', () => {
  it('reads the ticket cookie under the name streaming sets', () => {
    expect(/from_cookies: \[([^\]]*)\]/.exec(edge)?.[1]).toBe(PLAYBACK_COOKIE);
  });

  it('answers CORS with credentials to exactly one origin, never a wildcard', () => {
    expect(listUnder('allow_origin_string_match')).toEqual(['exact: http://localhost:3000']);
    expect(edge.match(/allow_origin_string_match:/g)).toHaveLength(1);
    expect(edge).toMatch(/^\s+allow_credentials: true$/m);
    expect(edge).not.toMatch(/safe_regex|allow_origin:/);
  });

  it("keeps the ticket cookie and the edge's own CORS answer from crossing it", () => {
    expect(edge).toMatch(/^\s+request_headers_to_remove: \[cookie\]$/m);
    expect(listUnder('response_headers_to_remove')).toEqual([
      'access-control-allow-origin',
      'access-control-allow-credentials',
    ]);
  });
});
