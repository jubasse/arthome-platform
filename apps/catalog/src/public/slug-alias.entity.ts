import { Column, Entity, PrimaryColumn } from 'typeorm';

import type { LinkKind } from './resolve-query.schema.js';

/**
 * A slug a URL used to carry, resolving to its page's current URL until `expires_at`
 * (`DomainConstant.SLUG_REDIRECT_DAYS`, D-075) and reserved until then: nobody else takes it.
 */
@Entity('public_slug_alias')
export class SlugAlias {
  @PrimaryColumn('text')
  kind!: LinkKind;

  /** A date's show id: a date's slug is unique within its show. Empty for a show or an artist. */
  @PrimaryColumn('text')
  scope!: string;

  @PrimaryColumn('text')
  slug!: string;

  @Column('uuid')
  target_id!: string;

  @Column('timestamptz')
  expires_at!: Date;
}
