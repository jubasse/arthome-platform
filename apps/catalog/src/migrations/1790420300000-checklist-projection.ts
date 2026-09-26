import { processedMessageTableDdl } from '@arthome-platform/messaging';
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * catalog becomes a consumer. `occurred_at` orders the facts of one checklist item: a retry
 * topic can deliver an older fact after a newer one, and the older must not win.
 */
export class ChecklistProjection1790420300000 implements MigrationInterface {
  name = 'ChecklistProjection1790420300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(processedMessageTableDdl());
    await queryRunner.query(`
      ALTER TABLE publication_checklist_fact
        ADD COLUMN occurred_at timestamptz NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE publication_checklist_fact DROP COLUMN occurred_at');
    await queryRunner.query('DROP TABLE processed_message');
  }
}
