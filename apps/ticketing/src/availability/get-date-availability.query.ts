import type { PerishableResponse } from '@arthome-platform/http-edge';
import { Query } from '@nestjs/cqrs';

import type { DateAvailability } from './date-availability.js';

/** The storefront's `refreshDateAvailability`. */
export class GetDateAvailability extends Query<PerishableResponse<DateAvailability>> {
  public constructor(public readonly dateId: string) {
    super();
  }
}
