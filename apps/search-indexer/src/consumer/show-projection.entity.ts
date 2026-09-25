import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The projection's bookkeeping: what this service believes the index holds.
 *
 * ⚠ IT IS A LEDGER, NOT A DECISION INPUT, AND THE HANDLER NEVER READS IT. The
 *   authority on "which version of this show is indexed" is OpenSearch's own
 *   `_version` — there has to be exactly one, or the two disagree the first
 *   time somebody reindexes and the one nobody is watching wins. Reading this
 *   table to decide whether to write would be that second source of truth.
 *
 * ⚠ SO WHAT IS IT FOR. Two things the index cannot do:
 *
 *   · RECONCILIATION. `SELECT count(*)` here against the index's document count
 *     is how you notice, cheaply, that the index has silently lost
 *     documents — a mistaken delete, a restore from an old snapshot, a reindex
 *     that stopped half-way. Without it, an index missing a thousand shows
 *     looks exactly like a catalogue with a thousand fewer shows.
 *
 *   · THE TRACE LINK. `traceparent` belongs here and NOT in the OpenSearch
 *     document: the document is a product payload served to surfaces, and trace
 *     context is operational data that has no business travelling to a client.
 *     Kept here, the link from a published show back to the command that
 *     published it survives (critical-rules.md §13).
 */
@Entity('show_projection')
export class ShowProjection {
  @PrimaryColumn('uuid')
  show_id!: string;

  /**
   * The external version written to OpenSearch: the event's `occurred_at` in
   * epoch milliseconds.
   *
   * ⚠ `bigint`, WHICH TypeORM HANDS BACK AS A STRING. Epoch milliseconds pass
   *   `int4` in 1970 and never again, and a column that silently overflows is
   *   not a column, it is an outage with a date on it. Nothing here reads the
   *   value back, so the string/number asymmetry costs nothing today — and it
   *   is written down because the day something does read it, the surprise is
   *   free to avoid and expensive to debug.
   */
  @Column('bigint')
  version!: string;

  /** W3C traceparent of the command that caused the publication, when there is one. */
  @Column('text', { nullable: true })
  traceparent!: string | null;

  @Column('timestamptz', { default: () => 'now()' })
  indexed_at!: Date;
}
