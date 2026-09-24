import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The deduplication key of every consumer in this repository.
 *
 * ⚠ DELIVERY IS AT LEAST ONCE, ALWAYS. The relay can crash between publishing
 *   and marking, CDC replays after a restart, a retry topic duplicates. So the
 *   question is never "can a message arrive twice" — it will — but "does the
 *   second arrival change anything".
 *
 * ⚠ THE ROW IS INSERTED INSIDE THE BUSINESS TRANSACTION, and that placement is
 *   the whole guarantee. A check-then-write outside it loses the effect on one
 *   ordering and doubles it on the other; a Redis `SET NX` puts the dedup state
 *   in a system that cannot roll back with the database (events.md §1.4).
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
