import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import type { ProfileKind } from './profile-kind.js';

/** A profile of the account (`data-model.md` §1.2). One per account this wave: its default. */
@Entity('profile')
export class Profile {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid')
  account_id!: string;

  @Column('text')
  name!: string;

  @Column('text')
  kind!: ProfileKind;

  @Column('boolean')
  is_default!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
