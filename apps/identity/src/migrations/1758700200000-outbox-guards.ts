import { outboxConstraints } from '@arthome-platform/messaging';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class OutboxGuards1758700200000 implements MigrationInterface {
  name = 'OutboxGuards1758700200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const constraint of outboxConstraints()) {
      await queryRunner.query(`ALTER TABLE outbox_event ADD ${constraint}`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const name of [
      'outbox_event_aggregatetype_is_topic_safe',
      'outbox_event_aggregateid_present',
      'outbox_event_type_is_versioned',
      'outbox_event_payload_not_empty',
    ]) {
      await queryRunner.query(`ALTER TABLE outbox_event DROP CONSTRAINT ${name}`);
    }
  }
}
