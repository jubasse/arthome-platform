import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import type { DeviceKind } from '@arthome/core';

/**
 * A registered device (`data-model.md` §1.3): durable, revocable, known by its token's digest
 *   alone. It belongs to no account: its sessions do (`DeviceSession`).
 */
@Entity('device')
export class Device {
  /** UUIDv7. */
  @PrimaryColumn('uuid')
  id!: string;

  @Column('text')
  token_hash!: string;

  @Column('timestamptz')
  token_expires_at!: Date;

  @Column('text')
  kind!: DeviceKind;

  @Column('text')
  label!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  /** Moves at sign-in only: resolving a session writes nothing. */
  @Column('timestamptz')
  last_seen_at!: Date;

  @Column('timestamptz', { nullable: true })
  revoked_at!: Date | null;
}
