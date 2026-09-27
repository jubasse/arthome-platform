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
import { applyChecklistMessage } from './dates/checklist-consumer.js';
import { ChecklistConsumerModule } from './dates/checklist-consumer.module.js';

/** The facts the publication checklist projects (data-model.md §2.3), all keyed by date id. */
export const SOURCE_TOPICS = [
  'arthome.ticketing.date_sales',
  'arthome.streaming.run',
  'arthome.chat.date',
];

/**
 * Stopped in `onApplicationShutdown`, which runs for the root module before the global TypeORM
 *   module closes the pool: a message in flight finishes its transaction first.
 */
@Injectable()
export class ChecklistConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
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
      service: Service.CATALOG,
      sources: SOURCE_TOPICS.map((topic) => ({
        topic,
        handler: (payload) => applyChecklistMessage(this.commands, payload),
      })),
      onDisposition: (topic, disposition) => console.log(`${topic} ${disposition}`),
    });
    console.log(
      `catalog consumer: ${SOURCE_TOPICS.join(', ')}, retrying on ${retryTopic(Service.CATALOG)}, dead-lettering to ${deadLetterTopic(Service.CATALOG)}`,
    );
  }

  public async onApplicationShutdown(): Promise<void> {
    await this.stopConsumers();
    await this.producer.disconnect();
  }
}

/** The consumer process: the command it dispatches and what that needs, no HTTP module. */
@Module({
  imports: [
    TypeOrmModule.forRoot(dataSource.options),
    CqrsModule.forRoot(),
    ChecklistConsumerModule,
  ],
  providers: [
    {
      provide: Kafka,
      useFactory: (): Kafka =>
        new Kafka({ clientId: Service.CATALOG, brokers: [...readKafkaBrokers()] }),
    },
    ChecklistConsumer,
  ],
})
export class ConsumerModule {}
