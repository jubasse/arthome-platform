import { describe, expect, it } from 'vitest';

import { composeImage } from './stack.js';

/**
 * The `compose.yaml` reader, asserted without a container.
 *
 * It is the riskiest thing in this package — a few lines of pattern matching
 * against a file nobody thinks of as an interface — and it is also the only part
 * of the harness that can go wrong while every container still starts. A reader
 * that silently returned nothing would make `startPostgres` throw, which is
 * fine; one that returned the WRONG service's image would make it pass, which is
 * not. So it is covered here, inside `pnpm run verify`, where a regression is
 * seen on the commit that causes it rather than on the next Docker-enabled run.
 *
 * ⚠ THE TAGS ARE NOT WRITTEN DOWN HERE. Asserting `postgres:18-alpine` would put
 *   the version in two places and turn an ordinary bump in compose.yaml into a
 *   failure in a package that has no opinion about it — the parallel literal
 *   table, rebuilt inside the test that exists to prevent one. What is asserted
 *   is that the reader found THAT service's image line, which is the part that
 *   can be wrong.
 */
describe('composeImage', () => {
  it('reads the image of the service it was asked about', () => {
    expect(composeImage('postgres')).toMatch(/^postgres:\S+$/);
    expect(composeImage('kafka')).toMatch(/^apache\/kafka:\S+$/);
    expect(composeImage('connect')).toMatch(/^quay\.io\/debezium\/connect:\S+$/);
    expect(composeImage('opensearch')).toMatch(/^opensearchproject\/opensearch:\S+$/);
  });

  it('does not run one service’s block into the next', () => {
    // The blocks are delimited by indentation alone, so an off-by-one in the
    // scan would hand back the image of whichever service is declared next —
    // and a harness that started OpenSearch believing it was Postgres would fail
    // a long way from here.
    expect(composeImage('postgres')).not.toBe(composeImage('kafka'));
  });

  it('says so rather than guessing when the service is not there', () => {
    expect(() => composeImage('nothing-declares-this')).toThrow(/declares no service/);
  });
});
