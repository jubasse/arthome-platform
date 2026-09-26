import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { UNIQUE_VIOLATION_CODES } from './unique-violations.js';

const migrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));

function columnsDeclaredUniqueByTheMigrations(): readonly string[] {
  const columns = new Set<string>();
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.ts'))) {
    const sql = readFileSync(`${migrationsDir}${file}`, 'utf8');
    for (const [, column] of sql.matchAll(/^\s*(\w+)\s+\w+\s+NOT NULL UNIQUE\s*,?\s*$/gm)) {
      if (column !== undefined) columns.add(column);
    }
  }
  return [...columns];
}

/**
 * THE FILTER'S OWN SUITE CANNOT CATCH THIS, AND DID NOT. It tests the mechanism
 *   against a fixture that copies this table, so it stayed green for a week while the
 *   service passed no table at all and every duplicate email answered 500. The
 *   mechanism being right is not the same fact as the service using it.
 */
describe('identity binds a code to every unique column it declares', () => {
  it('covers each column the migrations constrain', () => {
    const declared = UNIQUE_VIOLATION_CODES.map((entry) => entry.column);
    expect([...declared].sort()).toEqual([...columnsDeclaredUniqueByTheMigrations()].sort());
  });

  it('never maps two columns to one code, which would make the 409 ambiguous', () => {
    const codes = UNIQUE_VIOLATION_CODES.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
