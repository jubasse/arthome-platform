import type { EntityManager } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { updateReturning } from './update-returning.js';

function answering(result: unknown): Pick<EntityManager, 'query'> {
  return { query: () => Promise.resolve(result) } as unknown as Pick<EntityManager, 'query'>;
}

describe('updateReturning', () => {
  it('hands back the rows of the [rows, rowCount] pair an UPDATE answers', async () => {
    const rows = await updateReturning<{ attempts: number }>(
      answering([[{ attempts: 2 }], 1]),
      'UPDATE inbox SET attempts = attempts + 1 RETURNING attempts',
      [],
    );
    expect(rows).toEqual([{ attempts: 2 }]);
  });

  it('hands back no row when the UPDATE matched none', async () => {
    expect(
      await updateReturning(answering([[], 0]), 'UPDATE inbox SET x = 1 RETURNING x', []),
    ).toEqual([]);
  });

  it('refuses a statement that answered its rows alone, as an INSERT does', async () => {
    await expect(
      updateReturning(
        answering([{ id: 'a' }, { id: 'b' }]),
        'INSERT INTO t VALUES (1) RETURNING id',
        [],
      ),
    ).rejects.toThrow(/UPDATE or a DELETE/);
  });
});
