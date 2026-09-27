import { readKafkaBrokers } from '@arthome-platform/config';
import { deadLetterTopic, retryTopic, runConsumers } from '@arthome-platform/messaging';
import {
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Kafka, type Producer } from 'kafkajs';

import { Service } from '@arthome/core';

import { dataSource } from './data-source.js';
import { applyCatalogDateMessage } from './date-sales/catalog-date-messages.js';
import { CatalogFactsModule } from './date-sales/catalog-facts.module.js';

/** Keyed by `date_id` (events.md §3): a date's facts arrive in the order catalog committed them. */
export const CATALOG_DATE_TOPIC = 'arthome.catalog.date';

/**
 * Stopped in `onApplicationShutdown`, which runs for the root module before the global TypeORM
 *   module closes the pool: a message in flight finishes its transaction first.
 */
@Injectable()
export class CatalogDateConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly producer: Producer;
  private stopConsumers: () => Promise<void> = () => Promise.resolve();

  public constructor(
    private readonly kafka: Kafka,
    private readonly commands: CommandBus,
  ) {
    this.producer = kafka.producer();
  }

  public async onApplicationBootstrap(): Promise<void> {
    await this.producer.connect();
    this.stopConsumers = await runConsumers({
      kafka: this.kafka,
      producer: this.producer,
      service: Service.TICKETING,
      sources: [
        {
          topic: CATALOG_DATE_TOPIC,
          handler: (payload) => applyCatalogDateMessage(this.commands, payload),
        },
      ],
      onDisposition: (topic, disposition) => console.log(`${topic} ${disposition}`),
    });
    console.log(
      `ticketing consumer: ${CATALOG_DATE_TOPIC}, retrying on ${retryTopic(Service.TICKETING)}, dead-lettering to ${deadLetterTopic(Service.TICKETING)}`,
    );
  }

  public async onApplicationShutdown(): Promise<void> {
    await this.stopConsumers();
    await this.producer.disconnect();
  }
}

/** The consumer process: the command it dispatches and what that needs, no HTTP module. */
@Module({
  imports: [TypeOrmModule.forRoot(dataSource.options), CqrsModule.forRoot(), CatalogFactsModule],
  providers: [
    {
      provide: Kafka,
      useFactory: (): Kafka =>
        new Kafka({ clientId: Service.TICKETING, brokers: [...readKafkaBrokers()] }),
    },
    CatalogDateConsumer,
  ],
})
export class ConsumerModule {}
