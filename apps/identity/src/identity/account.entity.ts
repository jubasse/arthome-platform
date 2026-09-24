import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * The root aggregate of `identity` (data-model.md §1.1).
 *
 * ⚠ THIS IS THE SLICE WAVE 1 NEEDS, NOT THE WHOLE AGGREGATE. Passwords, TOTP,
 *   passkeys and profiles are absent on purpose: `adr-auth.md` gives
 *   authentication to better-auth in its own `auth` schema, with no TypeORM
 *   entity mapping its tables and the domain holding only the link. Modelling
 *   them here would be inventing the half of that decision that says the
 *   opposite.
 *
 * ⚠ `status` IS ABSENT TOO, AND THAT ONE WAS ADDED AND THEN TAKEN BACK. The
 *   data model names four states in prose — active, suspended,
 *   deletion_requested, anonymised — and @arthome/core carries NO vocabulary for
 *   them, so an ACCOUNT_STATUSES was written there. `check-vocabulary` refused
 *   it: `deletion_requested` appears in neither contract, and the register of
 *   domain-only vocabularies says in its own header that it is "not a place to
 *   park a vocabulary that has not been published yet".
 *
 *   It was right. Publishing an account-status field into the OpenAPI contract
 *   would have been inventing contract for a deletion saga nobody is building,
 *   and wave 1 never reads or transitions this column. The finding stands and is
 *   worth more than a column: THE DOMAIN IS MISSING ACCOUNT_STATUSES, and the
 *   first service that genuinely needs the lifecycle should add it together with
 *   the contract that serves it — not on its own, the way this nearly did.
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

  /** BCP 47, as resolved at sign-up. */
  @Column('text')
  locale!: string;

  /** ISO 3166-1 alpha-2. Territorial rights and billing market; re-evaluated at every read. */
  @Column('text')
  country!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
