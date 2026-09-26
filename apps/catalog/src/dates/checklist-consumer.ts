import {
  ChatMode,
  DateChatPolicyChangedSchema,
  DateSalesCapacitySetSchema,
  DateSalesPricingChangedSchema,
  TechnicalCheckPassedSchema,
} from '@arthome-platform/events';
import {
  PermanentError,
  ProcessedMessage,
  header,
  type Outcome,
} from '@arthome-platform/messaging';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate, type Timestamp } from '@bufbuild/protobuf/wkt';
import type { EachMessagePayload } from 'kafkajs';
import type { DataSource } from 'typeorm';

import { PublicationChecklistItem } from '@arthome/core';

import { PerformanceDate } from './performance-date.entity.js';

interface ChecklistFact {
  readonly dateId: string;
  readonly item: PublicationChecklistItem;
  readonly satisfied: boolean;
  readonly occurredAt: Date;
}

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
  dataSource: DataSource,
  payload: EachMessagePayload,
): Promise<Outcome> {
  const messageId = header(payload, 'message-id');
  if (messageId === null) {
    throw new PermanentError(`message on ${payload.topic} has no message-id header`);
  }
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

  return dataSource.transaction(async (manager) => {
    const claimed = await manager
      .createQueryBuilder()
      .insert()
      .into(ProcessedMessage)
      .values({ id: messageId, topic: payload.topic })
      .orIgnore()
      .returning('id')
      .execute();
    if ((claimed.raw as unknown[]).length === 0) return 'duplicate';

    // Catalog emits DateDrafted before any other context knows the date, so an unknown one is
    // a fault to look at, not a race to wait out.
    if (!(await manager.existsBy(PerformanceDate, { id: fact.dateId }))) {
      throw new PermanentError(`message ${messageId} is about date ${fact.dateId}, unknown here`);
    }

    // A retry topic can bring an older fact after a newer one for the same item: the WHERE is
    // what keeps it from winning.
    const written = await manager.query<unknown[]>(
      `INSERT INTO publication_checklist_fact (date_id, item, satisfied, occurred_at)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (date_id, item) DO UPDATE
               SET satisfied = excluded.satisfied,
                   occurred_at = excluded.occurred_at,
                   updated_at = now()
             WHERE excluded.occurred_at >= publication_checklist_fact.occurred_at
       RETURNING date_id`,
      [fact.dateId, fact.item, fact.satisfied, fact.occurredAt],
    );
    return written.length === 1 ? 'applied' : 'superseded';
  });
}
