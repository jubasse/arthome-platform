import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * A ledger — reconciliation against the index's document count, and the trace link a
 * product payload must not carry. ⚠ The handler never reads it: OpenSearch's `_version`
 * is the authority on which version is indexed, and a second one has the two disagree at
 * the first reindex.
 */
@Entity('show_projection')
export class ShowProjection {
  @PrimaryColumn('uuid')
  show_id!: string;

  /**
   * The event's `occurred_at` in epoch milliseconds — `bigint` because that overflows
   * `int4`, and a string because that is how TypeORM hands `bigint` back.
   */
  @Column('bigint')
  version!: string;

  @Column('text', { nullable: true })
  traceparent!: string | null;

  // ⚠ Named to match the migration's `CREATE INDEX show_projection_indexed_at`. A
  //   bare `@Index()` generates `IDX_<hash>`, which `migration:generate` then
  //   reconciles against the live name by emitting DROP and CREATE.
  @Index('show_projection_indexed_at')
  @Column('timestamptz', { default: () => 'now()' })
  indexed_at!: Date;
}
