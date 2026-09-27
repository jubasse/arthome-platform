import { Outcome, claimMessage } from '@arthome-platform/messaging';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import { ApiErrorCode, DomainError } from '@arthome/core';

import { PublicationRow } from './publication.entity.js';
import { RecordChecklistFact } from './record-checklist-fact.command.js';
import { CatalogTransactions } from '../catalog-transactions.js';

/**
 * Reached from Kafka alone, so it refuses with core's `DomainError`, never an HTTP exception: the
 *   consumer is the edge that maps it (`nestjs-request-pipeline` rule 1).
 */
@CommandHandler(RecordChecklistFact)
export class RecordChecklistFactHandler implements ICommandHandler<RecordChecklistFact> {
  public constructor(private readonly transactions: CatalogTransactions) {}

  public execute({ messageId, topic, fact }: RecordChecklistFact): Promise<Outcome> {
    return this.transactions.run(async ({ manager }) => {
      if (!(await claimMessage(manager, messageId, topic))) return Outcome.DUPLICATE;

      // Catalog emits DateDrafted before any other context knows the date, so an unknown one is
      // a fault to look at, not a race to wait out. Shared lock to the commit: a publication
      // deciding on the checklist holds the row, and this fact waits for it or it for this.
      const publication = await manager.findOne(PublicationRow, {
        where: { date_id: fact.dateId },
        lock: { mode: 'pessimistic_read' },
      });
      if (publication === null) {
        throw new DomainError({ code: ApiErrorCode.NOT_FOUND, params: { dateId: fact.dateId } });
      }

      // A retry topic can bring an older fact after a newer one for the same item: the WHERE is
      // what keeps it from winning.
      const written = await manager.query<unknown[]>(
        `INSERT INTO publication_checklist_fact (date_id, item, satisfied, occurred_at)
              VALUES ($1, $2, $3, $4)
         ON CONFLICT (date_id, item) DO UPDATE
                 SET satisfied = excluded.satisfied,
                     occurred_at = excluded.occurred_at,
                     updated_at = now()
               WHERE excluded.occurred_at >= publication_checklist_fact.occurred_at
         RETURNING date_id`,
        [fact.dateId, fact.item, fact.satisfied, fact.occurredAt],
      );
      return written.length === 1 ? 'applied' : 'superseded';
    });
  }
}
