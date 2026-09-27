import {
  ChatMode,
  DateChatPolicyChangedSchema,
  DateSalesCapacitySetSchema,
  DateSalesPricingChangedSchema,
  TechnicalCheckPassedSchema,
} from '@arthome-platform/events';
import { PermanentError, header, messageIdOf, type Outcome } from '@arthome-platform/messaging';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate, type Timestamp } from '@bufbuild/protobuf/wkt';
import type { CommandBus } from '@nestjs/cqrs';
import type { EachMessagePayload } from 'kafkajs';

import { ApiErrorCode, PublicationChecklistItem, isDomainError } from '@arthome/core';

import { RecordChecklistFact, type ChecklistFact } from './record-checklist-fact.command.js';

function stated(timestamp: Timestamp | undefined): Date {
  if (timestamp === undefined) throw new Error('no occurred_at');
  return timestampDate(timestamp);
}

/** What each consumed type says about one checklist item (data-model.md §2.3). */
const READERS: Readonly<Record<string, (value: Uint8Array) => ChecklistFact>> = {
  'ticketing.date_sales.pricing_changed.v1': (value) => {
    const event = fromBinary(DateSalesPricingChangedSchema, value);
    return {
      dateId: event.dateId,
      item: PublicationChecklistItem.AT_LEAST_ONE_ACTIVE_PRICE,
      satisfied: event.tiers.some((tier) => tier.active),
      occurredAt: stated(event.occurredAt),
    };
  },
  'ticketing.date_sales.capacity_set.v1': (value) => {
    const event = fromBinary(DateSalesCapacitySetSchema, value);
    return {
      dateId: event.dateId,
      item: PublicationChecklistItem.CAPACITY,
      satisfied: event.capacityTotal > 0,
      occurredAt: stated(event.occurredAt),
    };
  },
  'streaming.run.technical_check_passed.v1': (value) => {
    const event = fromBinary(TechnicalCheckPassedSchema, value);
    return {
      dateId: event.dateId,
      item: PublicationChecklistItem.TECHNICAL_CHECK_PASSED,
      satisfied: true,
      occurredAt: stated(event.passedAt),
    };
  },
  'chat.date_chat_policy.changed.v1': (value) => {
    const event = fromBinary(DateChatPolicyChangedSchema, value);
    return {
      dateId: event.dateId,
      item: PublicationChecklistItem.CHAT_MODE_SET,
      satisfied: event.mode !== ChatMode.UNSPECIFIED,
      occurredAt: stated(event.occurredAt),
    };
  },
};

export function applyChecklistMessage(
  commands: CommandBus,
  payload: EachMessagePayload,
): Promise<Outcome> {
  const messageId = messageIdOf(payload);
  const type = header(payload, 'type');
  const read = type === null ? undefined : READERS[type];
  if (read === undefined) return Promise.resolve('ignored');

  const value = payload.message.value;
  if (value === null) throw new PermanentError(`message ${messageId} has no value`);
  let fact: ChecklistFact;
  try {
    fact = read(new Uint8Array(value));
  } catch (cause) {
    throw new PermanentError(`message ${messageId} does not read as ${type}: ${String(cause)}`);
  }

  return commands
    .execute(new RecordChecklistFact(messageId, payload.topic, fact))
    .catch((error: unknown) => {
      // A refusal is a business rejection no retry changes: dead-lettered at once, its code in the
      // header. Anything else is retried as transient.
      if (!isDomainError(error)) throw error;
      const refusal =
        error.code === ApiErrorCode.NOT_FOUND ? 'unknown here' : `refused ${error.code}`;
      throw new PermanentError(`message ${messageId} is about date ${fact.dateId}, ${refusal}`);
    });
}
