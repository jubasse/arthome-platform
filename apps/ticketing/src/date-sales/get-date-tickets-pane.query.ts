import { Query } from '@nestjs/cqrs';

import type { DateSalesPane } from './date-sales-pane.js';

/** The studio's `getDateTicketsPane`. */
export class GetDateTicketsPane extends Query<DateSalesPane> {
  public constructor(public readonly dateId: string) {
    super();
  }
}
