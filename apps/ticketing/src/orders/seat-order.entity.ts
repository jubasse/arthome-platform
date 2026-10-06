import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import { type PriceTier, type OrderErrorCode, type OrderState } from '@arthome/core';

import { type NextAction } from '../payments/next-action.js';

export interface DeclaredTaxLocationColumn {
  readonly country: string;
  readonly subdivision: string | null;
  readonly postalCode: string | null;
}

/**
 * The `SeatOrder` aggregate's row, its writes conditioned on `version`. Amounts are Postgres's
 *   `bigint`, read as text.
 */
@Entity('seat_order')
export class SeatOrderRow {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('text')
  reference!: string;

  /** The purchase's `Idempotency-Key`, bound to this order for good. */
  @Column('uuid')
  idempotency_key!: string;

  @Column('uuid', { nullable: true })
  account_id!: string | null;

  @Column('text')
  fingerprint!: string;

  @Column('uuid')
  date_id!: string;

  @Column('text')
  channel_id!: string;

  @Column('uuid', { nullable: true })
  profile_id!: string | null;

  @Column('text')
  tier!: PriceTier;

  @Column('integer')
  quantity!: number;

  @Column('text')
  currency_code!: string;

  @Column('bigint')
  unit_price_minor!: string;

  @Column('bigint')
  tier_total_minor!: string;

  @Column('bigint')
  service_fee_minor!: string;

  @Column('bigint')
  discount_minor!: string;

  @Column('bigint')
  total_minor!: string;

  @Column('jsonb', { nullable: true })
  declared_tax_location!: DeclaredTaxLocationColumn | null;

  @Column('uuid')
  hold_id!: string;

  @Column('timestamptz')
  expires_at!: Date;

  @Column('text')
  state!: OrderState;

  @Column('text', { nullable: true })
  payment_intent_ref!: string | null;

  @Column('text', { nullable: true })
  client_secret!: string | null;

  @Column('jsonb', { nullable: true })
  next_action!: NextAction | null;

  @Column('text', { nullable: true })
  failure_code!: OrderErrorCode | null;

  @Column('text', { nullable: true })
  decline_code!: string | null;

  /** Set when the order failed with an intent the provider may still hold; cleared once cancelled. */
  @Column('timestamptz', { nullable: true })
  intent_cancel_owed_at!: Date | null;

  @Column('timestamptz')
  placed_at!: Date;

  @Column('timestamptz', { nullable: true })
  paid_at!: Date | null;

  /** What the purchase answered, replayed as it was under its key (transport.md §5.4). */
  @Column('integer', { nullable: true })
  answer_status!: number | null;

  @Column('json', { nullable: true })
  answer_body!: unknown;

  @Column('integer')
  version!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
