import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * The contract between this service and the Debezium outbox router.
 *
 * ⚠ THE COLUMN NAMES ARE NOT OURS TO CHOOSE. `aggregatetype`, `aggregateid`,
 *   `type` and `payload` are what the router expects, lowercase and unseparated
 *   (data-model.md §7.3). Renaming one to something more readable does not fail
 *   a test — it fails the connector, in production, silently.
 *
 * ⚠ THE APPLICATION ONLY EVER INSERTS. It never reads this table and never
 *   updates a row: CDC reads the write-ahead log. That is what makes
 *   `REPLICA IDENTITY DEFAULT` sufficient, and it is why there is no `status`
 *   column here — a row marked "published" by the application would be a second
 *   source of truth about something the connector already knows.
 */
@Entity('outbox_event')
export class OutboxEvent {
  /** UUIDv7. Becomes the `message-id` header, hence the consumer's dedup key. */
  @PrimaryColumn('uuid')
  id!: string;

  /** `identity.account` → topic `arthome.identity.account`. */
  @Column('text')
  aggregatetype!: string;

  /** The partition key, hence the order guarantee for one object. */
  @Column('text')
  aggregateid!: string;

  /** `identity.account.registered.v1` → the `type` header. */
  @Column('text')
  type!: string;

  /** Serialised Protobuf. Debezium transports the bytes and reads none of them. */
  @Column('bytea')
  payload!: Buffer;

  /**
   * W3C traceparent, injected HERE, at write time.
   *
   * The relay runs outside the request that caused the fact. Injecting later
   * means injecting a context that no longer exists, and the link between the
   * command and everything it causes is lost for good (events.md §1.3).
   */
  @Column('text', { nullable: true })
  tracecontext!: string | null;

  /** The person who caused the fact, when there is one. The studio journal reads it. */
  @Column('text', { nullable: true })
  actor_id!: string | null;

  @Index()
  @Column('timestamptz', { default: () => 'now()' })
  created_at!: Date;
}
