import { describe, expect, it } from 'vitest';

import { workerRedisUrl } from './redis.js';

describe('workerRedisUrl', () => {
  it('puts each worker on the database of its pool id', () => {
    expect(workerRedisUrl('redis://localhost:32768', '1')).toBe('redis://localhost:32768/1');
    expect(workerRedisUrl('redis://localhost:32768', '15')).toBe('redis://localhost:32768/15');
  });

  it('refuses a sixteenth worker rather than sharing a database', () => {
    expect(() => workerRedisUrl('redis://localhost:32768', '16')).toThrow(/cap `maxWorkers`/);
  });
});
