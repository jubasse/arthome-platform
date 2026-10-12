import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import type { ReplayPolicy, ReplayState } from '@arthome/core';

/** The row of the `Replay` aggregate, one per date; its writes are conditioned on `version`. */
@Entity('replay')
export class ReplayRow {
  @PrimaryColumn('uuid')
  date_id!: string;

  @Column('text')
  channel_id!: string;

  @Column('text')
  state!: ReplayState;

  @Column('text')
  policy!: ReplayPolicy;

  @Column('timestamptz')
  live_ended_at!: Date;

  @Column('timestamptz')
  closes_at!: Date;

  @Column('integer', { nullable: true })
  asset_duration_sec!: number | null;

  @Column('timestamptz', { nullable: true })
  asset_ready_at!: Date | null;

  @Column('timestamptz', { nullable: true })
  online_at!: Date | null;

  @Column('timestamptz', { nullable: true })
  closed_at!: Date | null;

  @Column('timestamptz', { nullable: true })
  withdrawn_at!: Date | null;

  @Column('integer')
  version!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
