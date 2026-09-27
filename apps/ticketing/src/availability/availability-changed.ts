import { DateSalesAvailabilityChangedSchema } from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';

import type { Instant } from '@arthome/core';

import type { AvailabilityFigures } from '../date-sales/date-sales-figures.js';
import type { TicketingEvent } from '../ticketing-events.js';

/** The figures as they stand at `occurredAt`, which is when they were read: the latest wins. */
export function availabilityChanged(
  dateId: string,
  channelId: string,
  figures: AvailabilityFigures,
  occurredAt: Instant,
): TicketingEvent {
  const { lowestPrice } = figures;
  return {
    type: 'ticketing.date_sales.availability_changed.v1',
    key: dateId,
    payload: toBinary(
      DateSalesAvailabilityChangedSchema,
      create(DateSalesAvailabilityChangedSchema, {
        dateId,
        channelId,
        seatsAvailable: figures.seatsAvailable,
        waitlistCount: figures.waitlistCount,
        fillRateBps: figures.fillRateBps,
        ...(lowestPrice !== null && {
          lowestPrice: {
            amountMinor: BigInt(lowestPrice.amountMinor),
            currencyCode: lowestPrice.currencyCode,
          },
        }),
        soldOut: figures.soldOut,
        occurredAt: timestampFromDate(new Date(occurredAt)),
      }),
    ),
    // A publication gathers moves from many requests: no one trace is its parent.
    traceparent: null,
  };
}
