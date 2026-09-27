import { idempotencyRecordTableDdl } from '@arthome-platform/http-edge';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import type { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CATALOG_SCHEMA } from '../itest/schema.js';

/**
 * Catalog's migrations created `idempotency_record` before the library had its DDL, and stay as
 *   they are. The library's scenarios run on the DDL's table, so they hold here only while the two
 *   tables are one.
 */

const STARTUP_MS = 240_000;

class LibraryIdempotencyRecord1790500000000 implements MigrationInterface {
  name = 'LibraryIdempotencyRecord1790500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(idempotencyRecordTableDdl());
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE idempotency_record');
  }
}

interface TableShape {
  readonly columns: unknown[];
  readonly constraints: unknown[];
  readonly indexes: unknown[];
}

async function shapeOf(dataSource: DataSource): Promise<TableShape> {
  return {
    columns: await dataSource.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'idempotency_record'
        ORDER BY ordinal_position`,
    ),
    constraints: await dataSource.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'idempotency_record'::regclass
        ORDER BY conname`,
    ),
    indexes: await dataSource.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'idempotency_record'
        ORDER BY indexname`,
    ),
  };
}

let stack: StartedStack;
let migrated: DataSource;
let fromLibrary: DataSource;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  migrated = await applyMigrations(
    await createDatabase(stack.postgres, 'catalog_idempotency_migrated'),
    CATALOG_SCHEMA,
  );
  fromLibrary = await applyMigrations(
    await createDatabase(stack.postgres, 'catalog_idempotency_library'),
    { entities: [], migrations: [LibraryIdempotencyRecord1790500000000] },
  );
}, STARTUP_MS);

afterAll(async () => {
  await migrated?.destroy();
  await fromLibrary?.destroy();
  await stack?.stop();
});

describe('idempotency_record', () => {
  it('is the table the library’s DDL creates, column for column, constraint and index', async () => {
    const shape = await shapeOf(migrated);

    expect(shape.columns).toHaveLength(8);
    expect(await shapeOf(fromLibrary)).toEqual(shape);
  });
});
