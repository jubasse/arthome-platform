import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { dateRecordsOf } from './date-records.js';
import { dateSheet, type DateSheet } from './date-sheet.js';
import { GetDateSheet } from './get-date-sheet.query.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

@QueryHandler(GetDateSheet)
export class GetDateSheetHandler implements IQueryHandler<GetDateSheet> {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(PUBLIC_WEB_ORIGIN) private readonly publicWebOrigin: string,
  ) {}

  public async execute({ dateId }: GetDateSheet): Promise<DateSheet> {
    return dateSheet(await dateRecordsOf(this.dataSource.manager, dateId), this.publicWebOrigin);
  }
}
