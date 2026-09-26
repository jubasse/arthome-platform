import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { PublicationState, ReplayPolicy, RightsScope } from '@arthome/core';

/** What DateScheduled states about a date. */
export interface ScheduledDateFields {
  readonly show_id: string;
  readonly channel_id: string;
  readonly venue_id: string;
  readonly starts_at: string;
  readonly venue_timezone: string;
  readonly venue_city: string;
  readonly venue_country: string;
  readonly runtime_min: number;
  readonly replay_policy: ReplayPolicy | null;
  readonly replay_window_hours: number;
  readonly rights_scope: RightsScope | null;
  readonly blackout_countries: readonly string[];
  readonly canonical_url: string;
}

/**
 * The indexer's copy of a date. A date is indexed once DateScheduled has made it public; a
 * publication state that arrives first is kept, and never indexed alone.
 */
@Entity('date_projection')
export class DateProjection {
  @PrimaryColumn('uuid')
  date_id!: string;

  @Index('date_projection_show_id')
  @Column('uuid', { nullable: true })
  show_id!: string | null;

  @Column('jsonb', { nullable: true })
  scheduled!: ScheduledDateFields | null;

  /** DateScheduled's `occurred_at`, in epoch milliseconds. */
  @Column('bigint', { nullable: true })
  scheduled_version!: string | null;

  @Column('text', { nullable: true })
  publication_state!: PublicationState | null;

  /** PublicationStateChanged's own `version`, the publication's, monotonic by construction. */
  @Column('bigint', { nullable: true })
  publication_version!: string | null;

  /**
   * Bumped under the row lock each time the document is recomposed, whichever input changed:
   * the one version both the date's facts and its show's can advance.
   */
  @Column('bigint', { default: 0 })
  doc_version!: string;

  @Column('timestamptz', { default: () => 'now()' })
  indexed_at!: Date;
}
