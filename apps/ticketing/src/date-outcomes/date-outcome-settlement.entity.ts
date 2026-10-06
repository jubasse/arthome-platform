import { Column, Entity, PrimaryColumn } from 'typeorm';

import { type DateOutcome } from '@arthome/core';

/**
 * A cancellation or an interruption to settle, written once by the consumer that recorded it; only
 *   the settlement pass locks it, before anything else it takes (HANDOVER §0n).
 */
@Entity('date_outcome_settlement')
export class DateOutcomeSettlementRow {
  @PrimaryColumn('uuid')
  date_id!: string;

  @Column('text')
  outcome!: DateOutcome;

  @Column('timestamptz')
  recorded_at!: Date;

  /** The outcome's message's, which every refund and credit of the date is owed under. */
  @Column('text', { nullable: true })
  traceparent!: string | null;

  @Column('timestamptz', { nullable: true })
  waitlist_ended_at!: Date | null;

  @Column('timestamptz', { nullable: true })
  settled_at!: Date | null;

  @Column('timestamptz', { nullable: true })
  failed_at!: Date | null;
}
