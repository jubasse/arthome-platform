import { describe, expect, it } from 'vitest';

import { composeImage } from './stack.js';

/**
 * The `compose.yaml` reader, asserted without a container: it is the one part of
 * the harness that can return the WRONG service's image and still let everything
 * start.
 *
 * ⚠ The tags are not written down here. Asserting `postgres:18-alpine` would put
 *   the version in two places — the parallel literal table this test exists to
 *   prevent.
 */
describe('composeImage', () => {
  it('reads the image of the service it was asked about', () => {
    expect(composeImage('postgres')).toMatch(/^postgres:\S+$/);
    expect(composeImage('kafka')).toMatch(/^apache\/kafka:\S+$/);
    expect(composeImage('connect')).toMatch(/^quay\.io\/debezium\/connect:\S+$/);
    expect(composeImage('opensearch')).toMatch(/^opensearchproject\/opensearch:\S+$/);
  });

  it('does not run one service’s block into the next', () => {
    expect(composeImage('postgres')).not.toBe(composeImage('kafka'));
  });

  it('says so rather than guessing when the service is not there', () => {
    expect(() => composeImage('nothing-declares-this')).toThrow(/declares no service/);
  });
});
