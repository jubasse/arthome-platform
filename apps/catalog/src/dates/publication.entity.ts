import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import type { PublicationState } from '@arthome/core';

/** data-model.md §2.3, one per date; its transitions are conditioned on `version`. */
@Entity('publication')
export class Publication {
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
