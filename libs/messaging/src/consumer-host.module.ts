import { readKafkaBrokers } from '@arthome-platform/config';
import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { Kafka, type EachMessagePayload, type Producer } from 'kafkajs';

import { runConsumers } from './consume.js';
import type { Outcome } from './dispatch.js';
import { deadLetterTopic, retryTopic } from './failure.js';

export interface ConsumerHostOptions {
  /** The consuming service's own name: its Kafka client id, its groups, its retry topic. */
  readonly service: string;
  readonly topics: readonly string[];
  /** One message read as the command it dispatches; see `MessageHandler` for its failures. */
  readonly apply: (commands: CommandBus, payload: EachMessagePayload) => Promise<Outcome>;
}

const CONSUMER_HOST_OPTIONS = Symbol('ConsumerHostOptions');

/**
 * Stopped in `onApplicationShutdown`, which Nest runs for the modules the root imports before the
 *   global ones: a message in flight finishes its transaction before TypeORM closes the pool.
 */
@Injectable()
export class ConsumerHost implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly producer: Producer;
  private stopConsumers: () => Promise<void> = () => Promise.resolve();

  public constructor(
    private readonly kafka: Kafka,
    private readonly commands: CommandBus,
    @Inject(CONSUMER_HOST_OPTIONS) private readonly options: ConsumerHostOptions,
  ) {
    this.producer = kafka.producer();
  }

  public async onApplicationBootstrap(): Promise<void> {
    const { service, topics, apply } = this.options;
    await this.producer.connect();
    this.stopConsumers = await runConsumers({
      kafka: this.kafka,
      producer: this.producer,
      service,
      sources: topics.map((topic) => ({
        topic,
        handler: (payload) => apply(this.commands, payload),
      })),
      onDisposition: (topic, disposition) => console.log(`${topic} ${disposition}`),
    });
    console.log(
      `${service} consumer: ${topics.join(', ')}, retrying on ${retryTopic(service)}, dead-lettering to ${deadLetterTopic(service)}`,
    );
  }

  public async onApplicationShutdown(): Promise<void> {
    await this.stopConsumers();
    await this.producer.disconnect();
  }
}

/**
 * A consumer process's Kafka client and consumers, beside the `CqrsModule.forRoot()` and the
 *   feature modules its root imports: each message becomes a command on the `CommandBus`.
 */
@Module({})
export class ConsumerHostModule {
  public static forRoot(options: ConsumerHostOptions): DynamicModule {
    return {
      module: ConsumerHostModule,
      providers: [
        { provide: CONSUMER_HOST_OPTIONS, useValue: options },
        {
          provide: Kafka,
          useFactory: (): Kafka =>
            new Kafka({ clientId: options.service, brokers: [...readKafkaBrokers()] }),
        },
        ConsumerHost,
      ],
    };
  }
}
