import { outboxConstraintNames, outboxConstraints } from '@arthome-platform/messaging';
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ⚠ WRITTEN FOR A LIVE TABLE, THOUGH THIS ONE IS EMPTY. `outboxConstraints()` is exported so
 *   six more services apply the same four checks, and by then `outbox_event` is the table every
 *   write inserts into. A plain `ADD CONSTRAINT` takes ACCESS EXCLUSIVE and scans the whole
 *   table; this is the shape that does not.
 */
export class OutboxGuards1758700200000 implements MigrationInterface {
  name = 'OutboxGuards1758700200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ⚠ Fail fast rather than queue: without it, this statement waits behind any open
    //   transaction holding the table, and every write queues behind the waiter. Three seconds
    //   turns a stalled deploy into a failed one, which is the recoverable outcome.
    await queryRunner.query(`SET LOCAL lock_timeout = '3s'`);

    for (const constraint of outboxConstraints()) {
      await queryRunner.query(`ALTER TABLE outbox_event ADD ${constraint} NOT VALID`);
    }

    /**
     * ⚠ VALIDATE IS A SEPARATE STATEMENT because it takes SHARE UPDATE EXCLUSIVE — it scans the
     *   table without blocking writes, where the combined form blocks them for the whole scan.
     *
     * ⚠ AND THIS IS ONLY HALF THE BENEFIT HERE: `migrationsTransactionMode` is TypeORM's default
     *   `'all'`, so the validate holds its lock until the batch commits. On a table large enough
     *   for the scan to matter, split it — `NOT VALID` in one migration, `VALIDATE` in the next —
     *   which is also what lets the second one run at a quiet hour.
     */
    for (const name of outboxConstraintNames()) {
      await queryRunner.query(`ALTER TABLE outbox_event VALIDATE CONSTRAINT ${name}`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const name of outboxConstraintNames()) {
      await queryRunner.query(`ALTER TABLE outbox_event DROP CONSTRAINT ${name}`);
    }
  }
}
