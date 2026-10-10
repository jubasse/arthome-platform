import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import type { IncidentCause, IncidentKind, IncidentTrigger, RunState } from '@arthome/core';

import type { IngestProtocol, MonitorPath } from '../media/media-ports.js';

/**
 * The `Run` aggregate's row. Its state columns are written conditioned on `version`; the presence
 *   columns and `after_grace_period` by conditional statements that leave the version alone.
 */
@Entity('run')
export class RunRow {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid')
  date_id!: string;

  @Column('uuid')
  channel_id!: string;

  @Column('text')
  state!: RunState;

  @Column('text')
  stream_path!: string;

  @Column('text')
  ingest_protocol!: IngestProtocol;

  @Column('text')
  monitor_path!: MonitorPath;

  @Column({ type: 'timestamptz', nullable: true })
  technical_check_passed_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  started_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  ended_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  publisher_online_since!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  publisher_lost_at!: Date | null;

  @Column('boolean')
  after_grace_period!: boolean;

  @Column('integer')
  version!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}

/** One of a run's incidents; the open one, `resolved_at` null, is unique per run. */
@Entity('incident')
export class IncidentRow {
  /** The client's, for one raised by hand. */
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid')
  run_id!: string;

  @Column('uuid')
  date_id!: string;

  @Column('text')
  kind!: IncidentKind;

  @Column('text')
  cause!: IncidentCause;

  @Column('text')
  trigger!: IncidentTrigger;

  @Column({ type: 'text', nullable: true })
  message_language!: string | null;

  @Column({ type: 'text', nullable: true })
  message_text!: string | null;

  @Column('timestamptz')
  raised_at!: Date;

  /** Null for the system. */
  @Column({ type: 'uuid', nullable: true })
  raised_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolved_at!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  resolved_by!: string | null;
}
