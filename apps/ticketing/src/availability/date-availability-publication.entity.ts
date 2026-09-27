import { Column, Entity, PrimaryColumn } from 'typeorm';

/** What the publisher last published for a date; only the publisher locks it. */
@Entity('date_availability_publication')
export class DateAvailabilityPublicationRow {
  @PrimaryColumn('uuid')
  date_id!: string;

  /** `date_sales.availability_moves` as the publication read it: a higher count is due. */
  @Column('bigint')
  published_moves!: string;

  @Column('timestamptz', { nullable: true })
  published_at!: Date | null;

  @Column('boolean', { nullable: true })
  published_sold_out!: boolean | null;

  @Column('timestamptz', { nullable: true })
  failed_at!: Date | null;

  /** Set when the sale closes, cleared by its last publication: closed sales are otherwise not read. */
  @Column('boolean')
  closing_due!: boolean;
}
