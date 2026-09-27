import { PerishableResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { Clock } from '@arthome/core';

import { DateDetailPublic } from './date-detail-public.entity.js';
import { dateDetailOf, type DateDetail } from './date-detail.js';
import { GetDateDetail } from './get-date-detail.query.js';
import { notFound } from './not-found.js';
import { CLOCK } from '../clock.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

@QueryHandler(GetDateDetail)
export class GetDateDetailHandler implements IQueryHandler<GetDateDetail> {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUBLIC_WEB_ORIGIN) private readonly publicWebOrigin: string,
  ) {}

  /** One query: the date's row and its show's other public rows. */
  public async execute({ dateId }: GetDateDetail): Promise<PerishableResponse<DateDetail>> {
    const rows = await this.dataSource.manager
      .createQueryBuilder(DateDetailPublic, 'row')
      .where('row.show_id = (SELECT show_id FROM date_detail_public WHERE date_id = :dateId)', {
        dateId,
      })
      .getMany();
    const page = dateDetailOf(rows, dateId, this.publicWebOrigin, this.clock.now());
    if (page === null) throw notFound();
    return new PerishableResponse(page.detail, page.validUntil);
  }
}
