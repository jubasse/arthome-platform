import { describe, expect, it } from 'vitest';

import { entityTagOf, noneMatch } from './conditional-get.js';

describe('the conditional GET', () => {
  const tag = entityTagOf({ data: { id: 'd1' }, validUntil: null });

  it('tags equal representations alike, and a change differently', () => {
    expect(entityTagOf({ data: { id: 'd1' }, validUntil: null })).toBe(tag);
    expect(entityTagOf({ data: { id: 'd2' }, validUntil: null })).not.toBe(tag);
  });

  it('compares weakly, through a list, and honours the wildcard', () => {
    expect(noneMatch(undefined, tag)).toBe(true);
    expect(noneMatch(tag, tag)).toBe(false);
    expect(noneMatch(tag.replace('W/', ''), tag)).toBe(false);
    expect(noneMatch(`W/"other", ${tag}`, tag)).toBe(false);
    expect(noneMatch('*', tag)).toBe(false);
    expect(noneMatch('W/"other"', tag)).toBe(true);
  });
});
