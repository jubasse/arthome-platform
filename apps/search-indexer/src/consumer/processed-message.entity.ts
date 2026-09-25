import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The deduplication key of this consumer, in this service's own database.
 *
 * ⚠ DELIVERY IS AT LEAST ONCE, ALWAYS. The relay can crash between publishing
 *   and marking, CDC replays after a restart, the retry topic duplicates. So
 *   the question is never "can a message arrive twice" — it will — but "does
 *   the second arrival change anything".
 *
 * ⚠ THE ROW IS INSERTED INSIDE THE BUSINESS TRANSACTION, and that placement is
 *   the whole guarantee. A check-then-write outside it loses the effect on one
 *   ordering and doubles it on the other; a Redis `SET NX` puts the dedup state
 *   in a system that cannot roll back with the database (events.md §1.4).
 *
 * ⚠ AND HERE THE ROW MEANS SOMETHING NARROWER THAN IN `notifications`, because
 *   this consumer's effect is not in this database. It means: "the OpenSearch
 *   write for this message has been observed to succeed." Its ABSENCE means
 *   "not known to have succeeded" — never "known not to have". That asymmetry
 *   is what makes replaying the topic safe, and it is the reason the index
 *   write happens BEFORE this transaction rather than after
 *   (`show-consumer.ts`).
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
