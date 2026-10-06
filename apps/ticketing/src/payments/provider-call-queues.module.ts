import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Logger, Module } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { SystemClock } from '@arthome/core';

import { IntentCancellationProcessor } from './intent-cancellation.processor.js';
import { OwedCallRelay, ProviderCallProducer, failFastTwinOf } from './owed-call-relay.js';
import { PaymentsModule } from './payments.module.js';
import {
  DEFAULT_PROVIDER_CALL_SCHEDULES,
  INTENT_CANCELLATION_QUEUE,
  PROVIDER_CALL_SCHEDULES,
  REFUND_QUEUE,
  providerCallJobOptions,
  type IntentCancellationJob,
  type ProviderCallSchedules,
  type RefundJob,
} from './provider-call-queues.js';
import { RefundProcessor } from './refund.processor.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactionsModule } from '../ticketing-transactions.js';

@Module({
  providers: [{ provide: PROVIDER_CALL_SCHEDULES, useValue: DEFAULT_PROVIDER_CALL_SCHEDULES }],
  exports: [PROVIDER_CALL_SCHEDULES],
})
export class ProviderCallSchedulesModule {}

/**
 * The worker process's queues, their processors and the relay that feeds them (HANDOVER §0m). The
 *   connection and the prefix are `BullModule.forRoot`'s, which the process's root module gives.
 */
@Module({
  imports: [
    TicketingTransactionsModule,
    PaymentsModule,
    ProviderCallSchedulesModule,
    BullModule.registerQueueAsync(
      {
        name: REFUND_QUEUE,
        imports: [ProviderCallSchedulesModule],
        inject: [PROVIDER_CALL_SCHEDULES],
        useFactory: ({ refunds }: ProviderCallSchedules) => ({
          defaultJobOptions: providerCallJobOptions(refunds),
        }),
      },
      {
        name: INTENT_CANCELLATION_QUEUE,
        imports: [ProviderCallSchedulesModule],
        inject: [PROVIDER_CALL_SCHEDULES],
        useFactory: ({ intentCancellations }: ProviderCallSchedules) => ({
          defaultJobOptions: providerCallJobOptions(intentCancellations),
        }),
      },
    ),
  ],
  providers: [
    RefundProcessor,
    IntentCancellationProcessor,
    OwedCallRelay,
    {
      provide: ProviderCallProducer,
      inject: [getQueueToken(REFUND_QUEUE), getQueueToken(INTENT_CANCELLATION_QUEUE)],
      useFactory: (
        refunds: Queue<RefundJob>,
        intentCancellations: Queue<IntentCancellationJob>,
      ): ProviderCallProducer => {
        const logger = new Logger(ProviderCallProducer.name);
        for (const registered of [refunds, intentCancellations]) {
          registered.on('error', (error) => {
            logger.warn(`${registered.name}: ${error.message}`);
          });
        }
        return new ProviderCallProducer(
          failFastTwinOf(refunds, logger),
          failFastTwinOf(intentCancellations, logger),
        );
      },
    },
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class ProviderCallQueuesModule {}
