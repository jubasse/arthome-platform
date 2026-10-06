import { idempotentRequestOf, type IdempotentRequest } from '@arthome-platform/http-edge';
import { Outcome } from '@arthome-platform/messaging';
import type { CommandBus } from '@nestjs/cqrs';

import { PriceTier, type Instant } from '@arthome/core';

import { delivered, drafted, engaged, scheduled } from './catalog-messages.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import { OpenCapacityTier } from '../date-sales/open-capacity-tier.command.js';
import { SetDatePrices } from '../date-sales/set-date-prices.command.js';
import { PurchaseSeat } from '../orders/purchase-seat.command.js';
import type { PurchaseSeatBody } from '../orders/purchase-seat.schema.js';
import { CancelSeat } from '../seats/cancel-seat.command.js';
import { RefundSeat } from '../seats/refund-seat.command.js';
import type { RefundSeatBody } from '../seats/refund-seat.schema.js';

/** The full price every date on sale here sells at. */
export const FULL_PRICE_MINOR = 2400;

let keys = 0;

/** A fresh `Idempotency-Key` per call, in a range no other suite writes. */
export function nextKey(): string {
  keys += 1;
  return `01a0fbff-0000-7000-8000-${String(keys).padStart(12, '0')}`;
}

function studioRequest(fingerprint: string): IdempotentRequest {
  return { key: nextKey(), accountId: null, fingerprint, statusCode: 200 };
}

export interface DateOnSale {
  readonly dateId: string;
  readonly channelId: string;
  readonly capacity: number;
  /** Stated by catalog, so its seats carry a cancel deadline. */
  readonly startsAt?: Instant;
}

/**
 * A date as the consumer and the studio leave it once catalog published it: opened, one tier, the
 *   full price at `FULL_PRICE_MINOR` EUR, the reduced one inactive, and its prices locked.
 */
export async function putOnSale(
  commands: CommandBus,
  { dateId, channelId, capacity, startsAt }: DateOnSale,
  now: Instant,
): Promise<void> {
  const applied = async (message: ReturnType<typeof drafted>): Promise<void> => {
    if ((await applyCatalogDateMessage(commands, delivered(message))) !== Outcome.APPLIED) {
      throw new Error(`catalog fact about ${dateId} not applied`);
    }
  };
  await applied(drafted(dateId, channelId, now));
  let version = 1;
  if (startsAt !== undefined) {
    await applied(scheduled(dateId, startsAt, now));
    version += 1;
  }
  await commands.execute(
    new OpenCapacityTier(
      dateId,
      { expectedVersion: version, additionalCapacity: capacity, notifyWaitlist: true },
      null,
      studioRequest(`${dateId}:tier`),
    ),
  );
  await commands.execute(
    new SetDatePrices(
      dateId,
      {
        expectedVersion: version + 1,
        tiers: [
          {
            tier: PriceTier.FULL,
            amountMinor: FULL_PRICE_MINOR,
            currencyCode: 'EUR',
            active: true,
          },
          { tier: PriceTier.REDUCED, amountMinor: 1600, currencyCode: 'EUR', active: false },
        ],
      },
      null,
      studioRequest(`${dateId}:prices`),
    ),
  );
  await applied(engaged(dateId, now));
}

/** The account the suites buy as, as the storefront BFF's token names it. */
export const ITEST_BUYER_ACCOUNT_ID = '019a0000-0000-7000-8000-00000000b0b0';

/** `quantity` full-price seats of the date, at the price it quotes, under `key`. */
export function purchaseOf(
  dateId: string,
  quantity: number,
  key: string = nextKey(),
  overrides: Partial<PurchaseSeatBody> = {},
  traceparent: string | null = null,
  lateEntryAcknowledged = false,
): PurchaseSeat {
  const body: PurchaseSeatBody = {
    dateId,
    tier: PriceTier.FULL,
    quantity,
    expectedTotal: { amountMinor: FULL_PRICE_MINOR * quantity, currencyCode: 'EUR' },
    ...overrides,
  };
  return new PurchaseSeat(
    body,
    { accountId: ITEST_BUYER_ACCOUNT_ID, profileId: null },
    traceparent,
    idempotentRequestOf('POST', '/v1/orders/seats', body, 201, key, ITEST_BUYER_ACCOUNT_ID),
    lateEntryAcknowledged,
  );
}

/** The buyer's `cancelSeat` of one seat, under `key`, as the storefront's route sends it. */
export function seatCancellationOf(
  seatId: string,
  key: string = nextKey(),
  accountId: string = ITEST_BUYER_ACCOUNT_ID,
  traceparent: string | null = null,
): CancelSeat {
  return new CancelSeat(
    seatId,
    accountId,
    traceparent,
    idempotentRequestOf('POST', `/v1/seats/${seatId}/cancel`, {}, 200, key, accountId),
  );
}

/** The studio's `refundSeat` of one seat, under `key`, its operator unnamed until auth slice B. */
export function seatRefundOf(
  seatId: string,
  body: RefundSeatBody,
  key: string = nextKey(),
  traceparent: string | null = null,
): RefundSeat {
  return new RefundSeat(
    seatId,
    body,
    null,
    traceparent,
    idempotentRequestOf('POST', `/v1/seats/${seatId}/refund`, body, 200, key, null),
  );
}
