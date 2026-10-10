import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import type { WaitlistEntryState } from '@arthome/core';

/** The `WaitlistEntry` aggregate's row, unique per date and account; its writes are conditioned on `version`. */
@Entity('waitlist_entry')
export class WaitlistEntryRow {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid')
  date_id!: string;

  @Column('uuid')
  account_id!: string;

  @Column('text')
  state!: WaitlistEntryState;

  @Column('timestamptz')
  joined_at!: Date;

  @Column('timestamptz', { nullable: true })
  notified_at!: Date | null;

  @Column('timestamptz', { nullable: true })
  ended_at!: Date | null;

  @Column('integer')
  version!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
