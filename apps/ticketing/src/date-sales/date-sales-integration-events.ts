import {
  DateSalesCapacitySetSchema,
  DateSalesPricingChangedSchema,
} from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EntityManager } from 'typeorm';

import type { Instant, TierPrice } from '@arthome/core';

import type { DateSalesEvent } from './date-sales.events.js';
import type { TechnicalProvision } from './technical-provision.js';
import { assertNever } from '../assert-never.js';
import { writeTicketingEvent, type TicketingEvent } from '../ticketing-events.js';
import { WIRE_PRICE_TIER } from '../wire.js';

/** What the wire says beyond the aggregate's facts. */
export interface DateSalesWireContext {
  /** The command's or the consumed message's, so the trace runs on through ticketing. */
  readonly traceparent: string | null;
}

/** One outbox row per event that has one, keyed by the date, in the order they were applied. */
export async function writeDateSalesIntegrationEvents(
  manager: EntityManager,
  events: readonly DateSalesEvent[],
  context: DateSalesWireContext,
): Promise<void> {
  for (const event of events) {
    const integration = integrationEventOf(event, context);
    if (integration !== null) {
      await writeTicketingEvent(manager, integration, new Date(event.occurredAt));
    }
  }
}

function integrationEventOf(
  event: DateSalesEvent,
  context: DateSalesWireContext,
): TicketingEvent | null {
  switch (event.kind) {
    case 'DateSalesOpened':
    case 'DateOutcomeRecorded':
      return null;
    case 'DatePricesSet':
      return pricingChanged(event, false, context);
    case 'DatePricesLocked':
      return pricingChanged(event, true, context);
    case 'CapacityTierOpened':
    case 'TechnicalProvisionSet':
      return capacitySet(event, context);
    case 'DateScheduleRecorded':
      // A start moves the revision deadline, which matters once a provision is required or recorded.
      return event.provision.required || event.provision.provisionedCapacity !== null
        ? capacitySet(event, context)
        : null;
    default:
      return assertNever(event);
  }
}

interface PricingFacts {
  readonly dateId: string;
  readonly channelId: string;
  readonly tiers: readonly TierPrice[];
  readonly occurredAt: Instant;
}

function pricingChanged(
  facts: PricingFacts,
  pricesLocked: boolean,
  context: DateSalesWireContext,
): TicketingEvent {
  return {
    type: 'ticketing.date_sales.pricing_changed.v1',
    key: facts.dateId,
    payload: toBinary(
      DateSalesPricingChangedSchema,
      create(DateSalesPricingChangedSchema, {
        dateId: facts.dateId,
        channelId: facts.channelId,
        tiers: facts.tiers.map(({ tier, amount, active }) => ({
          tier: WIRE_PRICE_TIER[tier],
          amount: { amountMinor: BigInt(amount.amountMinor), currencyCode: amount.currencyCode },
          active,
        })),
        pricesLocked,
        occurredAt: timestampFromDate(new Date(facts.occurredAt)),
      }),
    ),
    traceparent: context.traceparent,
  };
}

interface CapacityFacts {
  readonly dateId: string;
  readonly channelId: string;
  readonly capacityTotal: number;
  readonly provision: TechnicalProvision;
  readonly occurredAt: Instant;
}

function capacitySet(facts: CapacityFacts, context: DateSalesWireContext): TicketingEvent {
  const { revisableUntil, provisionedCapacity } = facts.provision;
  return {
    type: 'ticketing.date_sales.capacity_set.v1',
    key: facts.dateId,
    payload: toBinary(
      DateSalesCapacitySetSchema,
      create(DateSalesCapacitySetSchema, {
        dateId: facts.dateId,
        channelId: facts.channelId,
        capacityTotal: facts.capacityTotal,
        technicalProvisionRequired: facts.provision.required,
        ...(revisableUntil !== null && {
          provisionRevisableUntil: timestampFromDate(new Date(revisableUntil)),
        }),
        ...(provisionedCapacity !== null && { provisionedCapacity }),
        occurredAt: timestampFromDate(new Date(facts.occurredAt)),
      }),
    ),
    traceparent: context.traceparent,
  };
}
