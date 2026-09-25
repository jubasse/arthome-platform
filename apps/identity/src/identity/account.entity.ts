import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * ⚠ The wave 1 slice, not the whole aggregate: authentication belongs to better-auth's
 *   own schema (`adr-auth.md`), and `status` is absent until the account lifecycle has a
 *   published vocabulary and a contract to serve it.
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

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
