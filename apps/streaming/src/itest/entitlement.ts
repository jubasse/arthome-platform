import type { Outcome } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { create, toBinary, type DescMessage, type MessageInitShape } from '@bufbuild/protobuf';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { EachMessagePayload, IHeaders } from 'kafkajs';
import type { DataSource } from 'typeorm';

import type { Clock } from '@arthome/core';

import { STREAMING_SCHEMA } from './schema.js';
import { CLOCK } from '../clock.js';
import { applyStreamingMessage } from '../consumed-messages.js';
import { EntitlementConsumerModule } from '../entitlement/entitlement-consumer.module.js';

export const DATE_SALES_TOPIC = 'arthome.ticketing.date_sales';
export const ACCOUNT_TOPIC = 'arthome.ticketing.account';
export const CATALOG_DATE_TOPIC = 'arthome.catalog.date';

let issued = 0;

/** A fresh message-id per call, in a range no other suite writes. */
export function nextMessageId(): string {
  issued += 1;
  return `01a0f5ee-0000-7000-8000-${String(issued).padStart(12, '0')}`;
}

export interface WireMessage {
  readonly topic: string;
  readonly key: string;
  readonly value: Buffer;
  readonly headers: IHeaders;
}

/** What Debezium's router puts on a topic for one outbox row. */
export function wireMessage<Desc extends DescMessage>(
  topic: string,
  type: string,
  schema: Desc,
  key: string,
  init: MessageInitShape<Desc>,
  messageId: string = nextMessageId(),
): WireMessage {
  return {
    topic,
    key,
    value: Buffer.from(toBinary(schema, create(schema, init))),
    headers: { 'message-id': messageId, type },
  };
}

export function payloadOf(message: WireMessage): EachMessagePayload {
  const headers = Object.fromEntries(
    Object.entries(message.headers).map(([name, value]) => [name, Buffer.from(String(value))]),
  );
  return {
    topic: message.topic,
    partition: 0,
    message: { key: Buffer.from(message.key), value: message.value, headers },
  } as unknown as EachMessagePayload;
}

export interface Projection {
  readonly stack: StartedStack;
  readonly dataSource: DataSource;
  readonly commands: CommandBus;
  /** The message as the consumer applies it: read, then dispatched on the real bus. */
  readonly apply: (message: WireMessage) => Promise<Outcome>;
  readonly close: () => Promise<void>;
}

/** The consumer's entitlement module on a fresh database, the clock the suite gives. */
export async function startProjection(
  database: string,
  clock: Clock,
  options: { readonly kafka?: boolean; readonly startupTimeoutMs: number },
): Promise<Projection> {
  const stack = await startStack({
    postgres: true,
    kafka: options.kafka ?? false,
    startupTimeoutMs: options.startupTimeoutMs,
  });
  const dataSource = await applyMigrations(
    await createDatabase(stack.postgres, database),
    STREAMING_SCHEMA,
  );
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRootAsync({
        useFactory: () => dataSource.options,
        dataSourceFactory: () => Promise.resolve(dataSource),
      }),
      CqrsModule.forRoot(),
      EntitlementConsumerModule,
    ],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  await moduleRef.init();
  const commands = moduleRef.get(CommandBus);
  return {
    stack,
    dataSource,
    commands,
    apply: (message) => applyStreamingMessage(commands, payloadOf(message)),
    close: async () => {
      await moduleRef.close();
      await stack.stop();
    },
  };
}
