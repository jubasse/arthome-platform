import type { EntityManager } from 'typeorm';

/**
 * The rows an UPDATE or a DELETE … RETURNING wrote. Through `query()`, TypeORM answers those two
 *   commands `[rows, rowCount]` and every other one its rows alone: read as rows, the pair left the
 *   payment inbox's attempts undefined, so no event was ever given up on (T3 correctness M1).
 */
export async function updateReturning<Row>(
  queryable: Pick<EntityManager, 'query'>,
  sql: string,
  parameters: unknown[],
): Promise<Row[]> {
  const result = await queryable.query<unknown>(sql, parameters);
  if (!isRowsAndCount(result)) {
    throw new Error(
      'updateReturning runs an UPDATE or a DELETE … RETURNING: this one answered rows alone',
    );
  }
  return result[0] as Row[];
}

function isRowsAndCount(result: unknown): result is [unknown[], number] {
  return (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  );
}
