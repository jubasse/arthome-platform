import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import type { PriceTier } from '@arthome/core';

import type { SeatHoldOrigin, SeatHoldState } from './commerce-vocabulary.js';

/** The `SeatHold` aggregate's row; the sweeper expires active ones in bulk. */
@Entity('seat_hold')
export class SeatHoldRow {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid')
  date_id!: string;

  @Column('uuid', { nullable: true })
  account_id!: string | null;

  @Column('uuid', { nullable: true })
  profile_id!: string | null;

  @Column('text')
  tier!: PriceTier;

  @Column('integer')
  quantity!: number;

  @Column('text')
  origin!: SeatHoldOrigin;

  /** The checkout's order or the TV's pairing, whose expiry this hold shares. */
  @Column('uuid')
  origin_ref!: string;

  @Column('timestamptz')
  expires_at!: Date;

  @Column('text')
  state!: SeatHoldState;

  @Column('integer')
  version!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
