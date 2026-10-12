import { Column, Entity, PrimaryColumn } from 'typeorm';

import type { ReplayAccessOrigin, ReplayAccessRevocationReason } from '@arthome/core';

/**
 * The right to watch a date's replay (adr-replay §1), keyed by its seat: the holder is read through
 *   the seat when access is decided, so a transfer writes nothing here. Valid only while its seat
 *   is `active` (HANDOVER §0r).
 */
@Entity('replay_access')
export class ReplayAccessRow {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid')
  date_id!: string;

  @Column('uuid')
  seat_id!: string;

  @Column('text')
  origin!: ReplayAccessOrigin;

  @Column('timestamptz')
  granted_at!: Date;

  @Column('timestamptz', { nullable: true })
  revoked_at!: Date | null;

  @Column('text', { nullable: true })
  revocation_reason!: ReplayAccessRevocationReason | null;
}
