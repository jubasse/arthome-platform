import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import { type PriceTier, type SeatState } from '@arthome/core';

/** A seat of a `SeatOrder`, written by the order's repository alone. */
@Entity('seat')
export class SeatRow {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid')
  order_id!: string;

  @Column('uuid')
  date_id!: string;

  @Column('uuid', { nullable: true })
  account_id!: string | null;

  @Column('uuid', { nullable: true })
  profile_id!: string | null;

  @Column('text')
  tier!: PriceTier;

  @Column('text')
  seat_code!: string;

  @Column('text')
  state!: SeatState;

  @Column('timestamptz', { nullable: true })
  cancel_deadline!: Date | null;

  @Column('timestamptz')
  activated_at!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
