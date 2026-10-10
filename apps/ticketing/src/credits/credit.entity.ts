import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import { type CreditOrigin, type CreditState } from '@arthome/core';

/** The `Credit` aggregate's row, one per order and origin. Amounts are `bigint`, read as text. */
@Entity('credit')
export class CreditRow {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid')
  account_id!: string;

  @Column('text')
  channel_id!: string;

  @Column('uuid')
  order_id!: string;

  @Column('bigint')
  amount_minor!: string;

  @Column('text')
  currency_code!: string;

  @Column('text')
  origin!: CreditOrigin;

  @Column('uuid', { nullable: true })
  origin_ref!: string | null;

  @Column('text')
  state!: CreditState;

  @Column('timestamptz')
  expires_at!: Date;

  @Column('integer')
  version!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
