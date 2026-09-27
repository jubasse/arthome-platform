import type { PerishableResponse } from '@arthome-platform/http-edge';
import { Query } from '@nestjs/cqrs';

import type { DateDetail } from './date-detail.js';

/** The storefront's `getDateDetail`, `GET /v1/dates/:dateId`. */
export class GetDateDetail extends Query<PerishableResponse<DateDetail>> {
  public constructor(public readonly dateId: string) {
    super();
  }
}
