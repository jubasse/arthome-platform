import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The indexer's copy of a channel's public face, keyed by the channel: a date document names the
 * artist of its channel, and `ArtistUpdated` is the only source of the name.
 */
@Entity('artist_projection')
export class ArtistProjection {
  @PrimaryColumn('text')
  channel_id!: string;

  @Column('text')
  artist_id!: string;

  @Column('text')
  public_name!: string;

  /** `ArtistUpdated`'s `occurred_at` in epoch milliseconds. */
  @Column('bigint')
  version!: string;
}
