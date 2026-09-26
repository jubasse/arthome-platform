import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The deduplication key of every consumer in this repository. Delivery is at least once,
 * always: the relay can crash between publishing and marking, CDC replays, a retry duplicates.
 *
 * The row is inserted INSIDE the business transaction, and that placement is the guarantee:
 *   a check-then-write outside it loses the effect on one ordering and doubles it on the
 *   other, and a Redis `SET NX` cannot roll back with the database (events.md §1.4).
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
