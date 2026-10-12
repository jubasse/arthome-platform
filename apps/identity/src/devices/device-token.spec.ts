import { describe, expect, it } from 'vitest';

import { digestOf, newDeviceToken } from './device-token.js';

describe('the device token', () => {
  it('is 256 random bits in base64url, a new one each time', () => {
    const token = newDeviceToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(newDeviceToken()).not.toBe(token);
  });

  it('is kept as a stable SHA-256 hex digest, never as itself', () => {
    const token = newDeviceToken();
    expect(digestOf(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(digestOf(token)).toBe(digestOf(token));
    expect(digestOf(token)).not.toContain(token);
    expect(digestOf('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
