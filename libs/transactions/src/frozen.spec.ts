import { describe, expect, it } from 'vitest';

import { frozen } from './frozen.js';

describe('frozen', () => {
  it('freezes every level, so a nested array written in place throws', () => {
    const snapshot = frozen({ tiers: [{ capacity: 10 }], total: 10 });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => snapshot.tiers.push({ capacity: 5 })).toThrow(TypeError);
    expect(Object.isFrozen(snapshot.tiers[0])).toBe(true);
  });

  it('hands back the value itself, and a scalar or null as it came', () => {
    const value = { id: 'a' };

    expect(frozen(value)).toBe(value);
    expect(frozen(null)).toBeNull();
    expect(frozen(3)).toBe(3);
  });
});
