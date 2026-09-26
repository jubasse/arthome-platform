import { PerishableResponse, RefusalException } from '@arthome-platform/http-edge';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { ApiErrorCode, FailureNature, type Clock } from '@arthome/core';

import { DateDetailPublic } from './date-detail-public.entity.js';
import { dateDetailOf, type DateDetail } from './date-detail.js';
import { CLOCK } from '../clock.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/** api.not_found is "a route that does not resolve", which is exactly what a dead link is. */
export function notFound(): RefusalException {
  return new RefusalException(HttpStatus.NOT_FOUND, {
    code: ApiErrorCode.NOT_FOUND,
    params: {},
    nature: FailureNature.REFUSED,
  });
}

@Injectable()
export class PublicDatesService {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PUBLIC_WEB_ORIGIN) private readonly publicWebOrigin: string,
  ) {}

  /** One query: the date's row and its show's other public rows. */
  public async detail(dateId: string): Promise<PerishableResponse<DateDetail>> {
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
