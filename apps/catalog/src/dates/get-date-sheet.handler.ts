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

  /**
   * One snapshot for every row: the aggregate's version lives on the publication row, so a sheet
   *   reading the date before an outcome commits and the publication after would serve a version
   *   it does not show.
   */
  public async execute({ dateId }: GetDateSheet): Promise<DateSheet> {
    const records = await this.dataSource.transaction('REPEATABLE READ', (manager) =>
      dateRecordsOf(manager, dateId),
    );
    return dateSheet(records, this.publicWebOrigin);
  }
}
