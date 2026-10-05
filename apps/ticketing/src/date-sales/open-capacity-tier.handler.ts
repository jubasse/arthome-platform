import {
  notFound,
  runIdempotentlyVersioned,
  type MemorisedResponse,
} from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import type { Clock } from '@arthome/core';

import { OpenCapacityTier, type OpenedCapacityTier } from './open-capacity-tier.command.js';
import { readDateSalesPane } from './read-date-sales-pane.js';
import { recordDateSalesEvents } from './record-date-sales-events.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactions, type TicketingTransaction } from '../ticketing-transactions.js';

@CommandHandler(OpenCapacityTier)
export class OpenCapacityTierHandler implements ICommandHandler<OpenCapacityTier> {
  public constructor(
    private readonly transactions: TicketingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute(command: OpenCapacityTier): Promise<MemorisedResponse<OpenedCapacityTier>> {
    return this.transactions.run((transaction) =>
      runIdempotentlyVersioned(transaction.manager, command.idempotency, this.clock, () =>
        this.openIn(transaction, command),
      ),
    );
  }

  private async openIn(
    { manager, dateSales }: TicketingTransaction,
    { dateId, body, traceparent }: OpenCapacityTier,
  ): Promise<{ readonly data: OpenedCapacityTier; readonly version: number }> {
    const sales = await dateSales.findById(dateId);
    if (sales === null) throw notFound();

    sales.openCapacityTier(body.expectedVersion, body.additionalCapacity, this.clock.now());
    await dateSales.save(sales);
    await recordDateSalesEvents(manager, sales.getUncommittedEvents(), { traceparent });

    const pane = await readDateSalesPane(manager, dateId);
    if (pane === null) throw new Error(`date sales ${dateId} vanished inside its transaction`);
    return { data: { sales: pane, waitlistNotified: 0 }, version: sales.snapshot.version };
  }
}
