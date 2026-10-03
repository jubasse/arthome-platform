import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import type { AccountStatus } from '@arthome/core';

/**
 * The domain's half of an account (`data-model.md` §1.1). The credential lives in better-auth's
 *   `auth` schema under the same UUIDv7, which no entity here maps (`adr-auth.md` R2).
 */
@Entity('account')
export class Account {
  /** UUIDv7, never exposed. `public_handle` is what a surface shows. */
  @PrimaryColumn('uuid')
  id!: string;

  @Column('citext', { unique: true })
  public_handle!: string;

  @Column('citext', { unique: true })
  email!: string;

  @Column('text')
  locale!: string;

  @Column('text')
  country!: string;

  @Column('text')
  status!: AccountStatus;

  @Column('timestamptz', { nullable: true })
  email_verified_at!: Date | null;

  /** Null for an account registered before sign-up recorded the terms accepted. */
  @Column('integer', { nullable: true })
  terms_version!: number | null;

  @Column('timestamptz', { nullable: true })
  terms_accepted_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
