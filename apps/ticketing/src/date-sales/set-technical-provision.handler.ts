import { runIdempotentlyVersioned, type MemorisedResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import type { Clock } from '@arthome/core';

import { asConflict } from './conflict.js';
import type { DateSalesPane } from './date-sales-pane.js';
import { readDateSalesPane } from './read-date-sales-pane.js';
import { recordDateSalesEvents } from './record-date-sales-events.js';
import { SetTechnicalProvision } from './set-technical-provision.command.js';
import { CLOCK } from '../clock.js';
import { notFound } from '../refusals.js';
import { TicketingTransactions, type TicketingTransaction } from '../ticketing-transactions.js';

@CommandHandler(SetTechnicalProvision)
export class SetTechnicalProvisionHandler implements ICommandHandler<SetTechnicalProvision> {
  public constructor(
    private readonly transactions: TicketingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute(command: SetTechnicalProvision): Promise<MemorisedResponse<DateSalesPane>> {
    return this.transactions.run((transaction) =>
      runIdempotentlyVersioned(transaction.manager, command.idempotency, this.clock, () =>
        this.setIn(transaction, command),
      ),
    );
  }

  private async setIn(
    { manager, dateSales }: TicketingTransaction,
    { dateId, body, traceparent }: SetTechnicalProvision,
  ): Promise<{ readonly data: DateSalesPane; readonly version: number }> {
    const sales = await dateSales.findById(dateId);
    if (sales === null) throw notFound();

    await asConflict(() =>
      sales.setTechnicalProvision(body.expectedVersion, body.provisionedCapacity, this.clock.now()),
    );
    await asConflict(() => dateSales.save(sales));
    await recordDateSalesEvents(manager, sales.getUncommittedEvents(), { traceparent });

    const pane = await readDateSalesPane(manager, dateId);
    if (pane === null) throw new Error(`date sales ${dateId} vanished inside its transaction`);
    return { data: pane, version: sales.snapshot.version };
  }
}
