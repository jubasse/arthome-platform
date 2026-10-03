import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * One verification link (`adr-auth.md` §6.7): its token's hash, never the token, the address it was
 *   sent to, so it verifies nothing once the address changes, and the instant it was spent.
 */
@Entity('email_verification')
export class EmailVerification {
  @PrimaryColumn('text')
  token_hash!: string;

  @Column('uuid')
  account_id!: string;

  @Column('citext')
  email!: string;

  @Column('timestamptz')
  expires_at!: Date;

  @Column('timestamptz', { nullable: true })
  used_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
