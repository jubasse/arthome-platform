import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import { type RefundReason } from '@arthome/core';

/**
 * A refund of a `SeatOrder`, owed then made, written by the order's repository. `traceparent`,
 *   `enqueued_at` and `dead_at` are the queue's bookkeeping (`payments/refund-ledger.ts`, the relay,
 *   the processor), never the aggregate's.
 */
@Entity('order_refund')
export class OrderRefundRow {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid')
  order_id!: string;

  @Column('uuid', { nullable: true })
  seat_id!: string | null;

  @Column('bigint')
  amount_minor!: string;

  @Column('text')
  currency_code!: string;

  @Column('text')
  reason!: RefundReason;

  /** The provider's, stored as it was given: `refund:{refundId}`, or `refund:{orderId}` (D-082). */
  @Column('text')
  idempotency_key!: string;

  @Column('timestamptz')
  owed_at!: Date;

  @Column('text', { nullable: true })
  traceparent!: string | null;

  @Column('timestamptz', { nullable: true })
  enqueued_at!: Date | null;

  @Column('text', { nullable: true })
  refund_ref!: string | null;

  @Column('timestamptz', { nullable: true })
  refunded_at!: Date | null;

  @Column('timestamptz', { nullable: true })
  dead_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
