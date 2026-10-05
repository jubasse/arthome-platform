import { Outcome, claimMessage } from '@arthome-platform/messaging';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import { ApiErrorCode, DomainError, type Clock, type Instant } from '@arthome/core';

import { ApplyCatalogDateFact, type CatalogDateFact } from './apply-catalog-date-fact.command.js';
import { DateSales } from './date-sales.aggregate.js';
import { recordDateSalesEvents } from './record-date-sales-events.js';
import { assertNever } from '../assert-never.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactions, type TicketingTransaction } from '../ticketing-transactions.js';

type LaterFact = Exclude<CatalogDateFact, { readonly kind: 'drafted' }>;

function applied(sales: DateSales, fact: LaterFact, now: Instant): boolean {
  switch (fact.kind) {
    case 'lock':
      return sales.lockPrices(fact.statedAt, now);
    case 'start':
      return sales.recordSchedule(fact.startsAt, fact.statedAt, now);
    case 'outcome':
      return sales.recordOutcome(fact.outcome, fact.statedAt, now);
    default:
      return assertNever(fact);
  }
}

/**
 * Reached from Kafka alone, so it refuses with core's `DomainError`, never an HTTP exception: the
 *   consumer is the edge that maps it (`nestjs-request-pipeline` rule 1).
 */
@CommandHandler(ApplyCatalogDateFact)
export class ApplyCatalogDateFactHandler implements ICommandHandler<ApplyCatalogDateFact> {
  public constructor(
    private readonly transactions: TicketingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute({ messageId, topic, traceparent, fact }: ApplyCatalogDateFact): Promise<Outcome> {
    return this.transactions.run(async (transaction) => {
      if (!(await claimMessage(transaction.manager, messageId, topic))) return Outcome.DUPLICATE;
      const sales =
        fact.kind === 'drafted'
          ? await this.opened(transaction, fact)
          : await this.moved(transaction, fact);
      if (sales === null) return Outcome.SUPERSEDED;

      await transaction.dateSales.save(sales);
      await recordDateSalesEvents(transaction.manager, sales.getUncommittedEvents(), {
        traceparent,
      });
      return Outcome.APPLIED;
    });
  }

  /** Null when the date is already open: a second `drafted` under another message-id. */
  private async opened(
    { dateSales }: TicketingTransaction,
    fact: Extract<CatalogDateFact, { readonly kind: 'drafted' }>,
  ): Promise<DateSales | null> {
    if ((await dateSales.findById(fact.dateId)) !== null) return null;
    return DateSales.open(fact.dateId, fact.channelId, this.clock.now());
  }

  /** Null when a newer fact of the same kind was applied first. */
  private async moved(
    { dateSales }: TicketingTransaction,
    fact: LaterFact,
  ): Promise<DateSales | null> {
    const sales = await dateSales.findById(fact.dateId);
    if (sales === null) {
      throw new DomainError({ code: ApiErrorCode.NOT_FOUND });
    }
    return applied(sales, fact, this.clock.now()) ? sales : null;
  }
}
