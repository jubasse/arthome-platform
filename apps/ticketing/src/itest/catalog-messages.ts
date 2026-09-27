import {
  DateDraftedSchema,
  DateOutcomeDeclaredSchema,
  DateRescheduledSchema,
  DateScheduledSchema,
  PublicationEngagedSchema,
  PublicationEngagement,
  type DateOutcome as WireDateOutcome,
} from '@arthome-platform/events';
import { create, toBinary, type DescMessage, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EachMessagePayload, IHeaders } from 'kafkajs';

import type { Instant } from '@arthome/core';

import { CATALOG_DATE_TOPIC } from '../consumer.module.js';

let issued = 0;

/** A fresh message-id per call, in a range no other suite writes. */
export function nextMessageId(): string {
  issued += 1;
  return `01a0f9ee-0000-7000-8000-${String(issued).padStart(12, '0')}`;
}

export interface CatalogMessage {
  readonly key: string;
  readonly value: Buffer;
  readonly headers: IHeaders;
}

/** What Debezium's router puts on `arthome.catalog.date` for one of catalog's outbox rows. */
export function catalogMessage<Desc extends DescMessage>(
  type: string,
  schema: Desc,
  init: MessageInitShape<Desc> & { readonly dateId: string },
  messageId: string = nextMessageId(),
): CatalogMessage {
  return {
    key: init.dateId,
    value: Buffer.from(toBinary(schema, create(schema, init))),
    headers: { 'message-id': messageId, type },
  };
}

/** The same message as a consumer's handler receives it. */
export function delivered(message: CatalogMessage): EachMessagePayload {
  const headers: IHeaders = {};
  for (const [name, value] of Object.entries(message.headers)) {
    if (typeof value === 'string') headers[name] = Buffer.from(value);
  }
  return {
    topic: CATALOG_DATE_TOPIC,
    partition: 0,
    message: { key: Buffer.from(message.key), value: message.value, headers },
    heartbeat: () => Promise.resolve(),
    pause: () => () => undefined,
  } as unknown as EachMessagePayload;
}

const at = (instant: Instant) => timestampFromDate(new Date(instant));

export function drafted(dateId: string, channelId: string, statedAt: Instant): CatalogMessage {
  return catalogMessage('catalog.date.drafted.v1', DateDraftedSchema, {
    dateId,
    channelId,
    occurredAt: at(statedAt),
  });
}

export function engaged(dateId: string, statedAt: Instant): CatalogMessage {
  return catalogMessage('catalog.publication.engaged.v1', PublicationEngagedSchema, {
    dateId,
    engaged: [
      PublicationEngagement.PRICES,
      PublicationEngagement.REPLAY,
      PublicationEngagement.CHAT_MODE,
    ],
    occurredAt: at(statedAt),
  });
}

export function scheduled(dateId: string, startsAt: Instant, statedAt: Instant): CatalogMessage {
  return catalogMessage('catalog.date.scheduled.v1', DateScheduledSchema, {
    dateId,
    startsAt: at(startsAt),
    occurredAt: at(statedAt),
  });
}

export function rescheduled(dateId: string, startsAt: Instant, statedAt: Instant): CatalogMessage {
  return catalogMessage('catalog.date.rescheduled.v1', DateRescheduledSchema, {
    dateId,
    newStartsAt: at(startsAt),
    occurredAt: at(statedAt),
  });
}

export function outcomeDeclared(
  dateId: string,
  outcome: WireDateOutcome,
  statedAt: Instant,
): CatalogMessage {
  return catalogMessage('catalog.date.outcome_declared.v1', DateOutcomeDeclaredSchema, {
    dateId,
    outcome,
    declaredAt: at(statedAt),
  });
}
