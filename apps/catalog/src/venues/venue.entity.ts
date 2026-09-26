import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * data-model.md §2.4, sliced to what a date needs: where it is, and the IANA zone its venue
 * clock is computed in. Region, capacity and venue type come with their first reader.
 */
@Entity('venue')
export class Venue {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('text')
  name!: string;

  @Column('text')
  city!: string;

  /** ISO 3166-1 alpha-2. */
  @Column('text')
  country!: string;

  /** IANA, never an offset (D3): the offset is computed for each instant it qualifies. */
  @Column('text')
  time_zone!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
