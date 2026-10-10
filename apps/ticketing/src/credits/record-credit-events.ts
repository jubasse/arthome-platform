import { CreditIssuedSchema } from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EntityManager } from 'typeorm';

import { CreditOrigin } from '@arthome/core';

import type { CreditEvent, CreditIssued } from './credit.events.js';
import { assertNever } from '../assert-never.js';
import { writeTicketingEvent, type TicketingEvent } from '../ticketing-events.js';
import { WIRE_CREDIT_ORIGIN } from '../wire.js';

/**
 * A credit's events as outbox rows in its command's transaction, in the order applied, keyed by
 *   the account (events.md §3.1): `credit.issued` is for payouts and notifications.
 */
export async function recordCreditEvents(
  manager: EntityManager,
  events: readonly CreditEvent[],
  traceparent: string | null,
): Promise<void> {
  for (const event of events) {
    await writeTicketingEvent(manager, wireFormOf(event, traceparent), new Date(event.occurredAt));
  }
}

function wireFormOf(event: CreditEvent, traceparent: string | null): TicketingEvent {
  switch (event.kind) {
    case 'CreditIssued':
      return creditIssued(event, traceparent);
    default:
      return assertNever(event.kind);
  }
}

function creditIssued(
  { credit, occurredAt }: CreditIssued,
  traceparent: string | null,
): TicketingEvent {
  return {
    type: 'ticketing.credit.issued.v1',
    key: credit.accountId,
    payload: toBinary(
      CreditIssuedSchema,
      create(CreditIssuedSchema, {
        creditId: credit.id,
        accountId: credit.accountId,
        channelId: credit.channelId,
        amount: {
          amountMinor: BigInt(credit.amount.amountMinor),
          currencyCode: credit.amount.currencyCode,
        },
        origin: WIRE_CREDIT_ORIGIN[credit.origin],
        originDateId:
          credit.origin === CreditOrigin.INTERRUPTED_DATE ? (credit.originRef ?? '') : '',
        expiresAt: timestampFromDate(new Date(credit.expiresAt)),
        occurredAt: timestampFromDate(new Date(occurredAt)),
      }),
    ),
    traceparent,
  };
}
