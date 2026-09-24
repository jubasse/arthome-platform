import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The business effect, kept deliberately trivial: wave 1 proves the PATH, not
 * what notifications eventually does with it. What matters is that exactly one
 * row appears per account however many times the message is delivered.
 */
@Entity('welcome_email')
export class WelcomeEmail {
  @PrimaryColumn('uuid')
  account_id!: string;

  @Column('text')
  locale!: string;

  @Column('text')
  country!: string;

  @Column('text', { nullable: true })
  traceparent!: string | null;

  @Column('timestamptz', { default: () => 'now()' })
  queued_at!: Date;
}
