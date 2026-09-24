import { describe, expect, it } from 'vitest';

import { readEnv } from './env.js';

describe('readEnv', () => {
  it('reads a well-formed environment', () => {
    expect(readEnv({ NODE_ENV: 'test', PORT: '3000' })).toEqual({
      NODE_ENV: 'test',
      PORT: 3000,
    });
  });

  it('coerces PORT, because an environment variable is always a string', () => {
    expect(readEnv({ NODE_ENV: 'test', PORT: '8080' }).PORT).toBe(8080);
  });

  it('throws on a missing variable rather than defaulting', () => {
    expect(() => readEnv({ NODE_ENV: 'test' })).toThrow();
  });

  it('throws on a port outside the range', () => {
    expect(() => readEnv({ NODE_ENV: 'test', PORT: '70000' })).toThrow();
  });

  it('refuses an unknown NODE_ENV instead of passing it through', () => {
    expect(() => readEnv({ NODE_ENV: 'staging', PORT: '3000' })).toThrow();
  });
});
