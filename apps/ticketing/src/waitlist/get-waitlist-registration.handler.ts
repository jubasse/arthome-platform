import { notFound } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { Clock } from '@arthome/core';

import { GetWaitlistRegistration } from './get-waitlist-registration.query.js';
import { WaitlistEntryRow } from './waitlist-entry.entity.js';
import { waitlistRegistrationOf, type WaitlistRegistrationView } from './waitlist-registration.js';
import { CLOCK } from '../clock.js';
import { DateSalesRow } from '../date-sales/date-sales.entity.js';

/** The caller's entry and the date's window, read unlocked; a sale never opened is 404, as the join. */
@QueryHandler(GetWaitlistRegistration)
export class GetWaitlistRegistrationHandler implements IQueryHandler<GetWaitlistRegistration> {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute({
    dateId,
    accountId,
  }: GetWaitlistRegistration): Promise<WaitlistRegistrationView> {
    const { manager } = this.dataSource;
    const sales = await manager.findOneBy(DateSalesRow, { date_id: dateId });
    if (sales?.prices_locked_at == null) throw notFound();
    const entry = await manager.findOne(WaitlistEntryRow, {
      select: { state: true },
      where: { date_id: dateId, account_id: accountId },
    });
    return waitlistRegistrationOf(
      entry?.state ?? null,
      {
        priorityUntil: sales.priority_until?.toISOString() ?? null,
        priorityPoolSeats: sales.priority_pool_seats,
      },
      this.clock.now(),
    );
  }
}
