import { Query } from '@nestjs/cqrs';

import type { DateSheet } from './date-sheet.js';

/** The studio's date sheet, `GET /dates/:dateId`. */
export class GetDateSheet extends Query<DateSheet> {
  public constructor(public readonly dateId: string) {
    super();
  }
}
