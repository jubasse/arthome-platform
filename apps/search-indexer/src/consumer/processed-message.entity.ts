import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The deduplication key, inserted inside the business transaction so dedup state cannot
 * roll back separately from the effect. A row means "the OpenSearch write was observed
 * to succeed"; its absence means "not known to have succeeded", never "known not to
 * have" — the asymmetry that makes replaying the topic safe.
 */
@Entity('processed_message')
export class ProcessedMessage {
  /** The `message-id` header: the outbox row's UUIDv7. */
  @PrimaryColumn('uuid')
  id!: string;

  @Column('text')
  topic!: string;

  @Column('timestamptz', { default: () => 'now()' })
  processed_at!: Date;
}
