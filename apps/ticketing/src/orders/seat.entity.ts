import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import { type PriceTier, type SeatCancelReason, type SeatState } from '@arthome/core';

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

  /** When it left `active`; null while active, which a CHECK holds. */
  @Column('timestamptz', { nullable: true })
  ended_at!: Date | null;

  @Column('text', { nullable: true })
  cancel_reason!: SeatCancelReason | null;

  /** The refund that gives this seat's money back, made once it is `refunded`. */
  @Column('uuid', { nullable: true })
  refund_id!: string | null;

  /** In its order's currency, with `refund_id`. */
  @Column('bigint', { nullable: true })
  refund_amount_minor!: string | null;

  @Column('uuid', { nullable: true })
  credit_id!: string | null;

  /** In its order's currency, with `credit_id`. */
  @Column('bigint', { nullable: true })
  credit_amount_minor!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
