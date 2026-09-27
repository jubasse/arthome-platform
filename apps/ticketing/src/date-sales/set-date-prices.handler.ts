import { runIdempotentlyVersioned, type MemorisedResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import { money, type Clock, type TierPrice } from '@arthome/core';

import { asConflict } from './conflict.js';
import type { DateSalesPane } from './date-sales-pane.js';
import { readDateSalesPane } from './read-date-sales-pane.js';
import { recordDateSalesEvents } from './record-date-sales-events.js';
import { SetDatePrices } from './set-date-prices.command.js';
import type { SetDatePricesBody } from './set-date-prices.schema.js';
import { CLOCK } from '../clock.js';
import { notFound } from '../refusals.js';
import { TicketingTransactions, type TicketingTransaction } from '../ticketing-transactions.js';

function sentPricesOf(tiers: SetDatePricesBody['tiers']): TierPrice[] {
  return tiers.map(({ tier, amountMinor, currencyCode, active }) => ({
    tier,
    amount: money(amountMinor, currencyCode),
    active,
  }));
}

@CommandHandler(SetDatePrices)
export class SetDatePricesHandler implements ICommandHandler<SetDatePrices> {
  public constructor(
    private readonly transactions: TicketingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute(command: SetDatePrices): Promise<MemorisedResponse<DateSalesPane>> {
    return this.transactions.run((transaction) =>
      runIdempotentlyVersioned(transaction.manager, command.idempotency, this.clock, () =>
        this.setIn(transaction, command),
      ),
    );
  }

  private async setIn(
    { manager, dateSales }: TicketingTransaction,
    { dateId, body, traceparent }: SetDatePrices,
  ): Promise<{ readonly data: DateSalesPane; readonly version: number }> {
    const sales = await dateSales.findById(dateId);
    if (sales === null) throw notFound();

    await asConflict(() =>
      sales.setPrices(body.expectedVersion, sentPricesOf(body.tiers), this.clock.now()),
    );
    await asConflict(() => dateSales.save(sales));
    await recordDateSalesEvents(manager, sales.getUncommittedEvents(), { traceparent });

    const pane = await readDateSalesPane(manager, dateId);
    if (pane === null) throw new Error(`date sales ${dateId} vanished inside its transaction`);
    return { data: pane, version: sales.snapshot.version };
  }
}
