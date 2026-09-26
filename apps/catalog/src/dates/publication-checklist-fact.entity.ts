import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import type { PublicationChecklistItem } from '@arthome/core';

/** A checklist fact another context reported, kept current by its events (§2.3). */
@Entity('publication_checklist_fact')
export class PublicationChecklistFact {
  @PrimaryColumn('uuid')
  date_id!: string;

  @PrimaryColumn('text')
  item!: PublicationChecklistItem;

  @Column('boolean')
  satisfied!: boolean;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
