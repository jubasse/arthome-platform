import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The (device, profile) pair a better-auth session is bound to (`data-model.md` §1.3). A session
 *   with no open binding resolves to nothing.
 */
@Entity('device_session')
export class DeviceSession {
  /** Random, not UUIDv7: it travels in a URL. */
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid')
  device_id!: string;

  @Column('uuid')
  account_id!: string;

  @Column('uuid')
  profile_id!: string;

  /** better-auth's session id, in the `auth` schema, which no foreign key reaches. */
  @Column('text')
  auth_session_id!: string;

  @Column('timestamptz')
  opened_at!: Date;

  @Column('timestamptz', { nullable: true })
  closed_at!: Date | null;
}
