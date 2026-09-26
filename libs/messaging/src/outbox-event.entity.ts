import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * The contract between this service and the Debezium outbox router.
 *
 * The column names are the router's, not ours — lowercase and unseparated (§7.3). Renaming
 *   one to something more readable does not fail a test; it fails the connector, silently.
 * The application only ever INSERTS; CDC reads the write-ahead log. That is what makes
 *   `REPLICA IDENTITY DEFAULT` sufficient, and why there is no `status` column.
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
   * Injected here, at write time: the relay runs outside the request that caused the fact,
   *   so injecting later injects a context that no longer exists and the link between the
   *   command and everything it causes is lost for good (events.md §1.3).
   */
  @Column('text', { nullable: true })
  tracecontext!: string | null;

  /** The person who caused the fact, when there is one. The studio journal reads it. */
  @Column('text', { nullable: true })
  actor_id!: string | null;

  @Index('idx_outbox_event_created_at')
  @Column('timestamptz', { default: () => 'now()' })
  created_at!: Date;
}
