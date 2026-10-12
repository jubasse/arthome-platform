import { Column, Entity, PrimaryColumn } from 'typeorm';

import type { ReplayPolicy, ReplayState } from '@arthome/core';

/** One per date, written by `RecordReplayState` alone, and locked before the date's accesses. */
@Entity('replay_window')
export class ReplayWindowRow {
  @PrimaryColumn('uuid')
  date_id!: string;

  @Column('text')
  state!: ReplayState;

  @Column('bigint')
  version!: string;

  @Column('text')
  policy!: ReplayPolicy;

  @Column('timestamptz')
  live_ended_at!: Date;

  @Column('timestamptz')
  closes_at!: Date;

  @Column('timestamptz', { nullable: true })
  online_at!: Date | null;

  /** When the date's seats got their accesses; null while they have none. */
  @Column('timestamptz', { nullable: true })
  granted_at!: Date | null;

  /** When a withdrawal revoked them, which a CHECK ties to `withdrawn`. */
  @Column('timestamptz', { nullable: true })
  revoked_at!: Date | null;

  /** When the kept version was recorded, at ticketing's clock. */
  @Column('timestamptz')
  recorded_at!: Date;
}
