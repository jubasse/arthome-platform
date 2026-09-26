import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Authored text in the language it was written in, as the contract's biography carries it. */
export interface LocalizedCopy {
  readonly contentLanguage: string;
  readonly text: string;
}

/**
 * data-model.md §2.4's `Artist`: the channel's public face, 1:1 with `identity.Channel` by
 * `channel_id`, written by the studio's `updateChannelIdentity` only.
 */
@Entity('artist')
export class Artist {
  /** UUIDv7, generated here when the channel first gets a public face. */
  @PrimaryColumn('uuid')
  id!: string;

  @Column('text')
  channel_id!: string;

  @Column('text')
  public_name!: string;

  @Column('text')
  slug!: string;

  @Column('jsonb')
  biography!: LocalizedCopy[];

  @Column('text')
  category_id!: string;

  /** Conditional commands name it; the first one creates the artist at version 1. */
  @Column('integer')
  version!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  joined_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
