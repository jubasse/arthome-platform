import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ticketing's version on `subscription.changed` (SD1). Kept rows stay unversioned: nothing
 *   published one before, so they keep being ordered by `occurred_at` until a versioned fact lands.
 */
export class SubscriptionVersion1791900100000 implements MigrationInterface {
  name = 'SubscriptionVersion1791900100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE entitlement_subscription ADD COLUMN version bigint NULL');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE entitlement_subscription DROP COLUMN version');
  }
}
