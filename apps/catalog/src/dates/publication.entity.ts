import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import type { PublicationState } from '@arthome/core';

/** The row of the `Publication` aggregate; its writes are conditioned on `version`. */
@Entity('publication')
export class PublicationRow {
  @PrimaryColumn('uuid')
  date_id!: string;

  @Column('text')
  channel_id!: string;

  @Column('text')
  state!: PublicationState;

  @Column('integer')
  version!: number;

  @Column('timestamptz', { nullable: true })
  published_at!: Date | null;

  @Column('timestamptz', { nullable: true })
  prices_locked_at!: Date | null;

  @Column('timestamptz', { nullable: true })
  replay_online_at!: Date | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
