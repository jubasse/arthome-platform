import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Every consumer's deduplication ledger, inserted inside the business transaction so it cannot
 * roll back separately from the effect. A row means the effect committed; its absence means
 * "not known to have", never "known not to have", which is what makes replaying a topic safe.
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

export function processedMessageTableDdl(): string {
  return `
    CREATE TABLE processed_message (
      id           uuid        PRIMARY KEY,
      topic        text        NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}
