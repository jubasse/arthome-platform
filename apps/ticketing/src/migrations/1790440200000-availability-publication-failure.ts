import type { MigrationInterface, QueryRunner } from 'typeorm';

/** When a date's publication last failed: it waits before it is tried again, behind the others. */
export class AvailabilityPublicationFailure1790440200000 implements MigrationInterface {
  name = 'AvailabilityPublicationFailure1790440200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE date_availability_publication ADD COLUMN failed_at timestamptz NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE date_availability_publication DROP COLUMN failed_at');
  }
}
