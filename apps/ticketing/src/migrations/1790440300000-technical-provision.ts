import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The capacity a date's recorded technical provision covers (D-088); null while none is. */
export class TechnicalProvision1790440300000 implements MigrationInterface {
  name = 'TechnicalProvision1790440300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE date_sales ADD COLUMN provisioned_capacity integer NULL CHECK (provisioned_capacity > 0)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE date_sales DROP COLUMN provisioned_capacity');
  }
}
